// 주제를 비우고 영상만 올렸을 때, 올린 영상과 비슷한 주제를 알아서 고릅니다.
// 1) 파일 이름에 뜻있는 말이 있으면 그 말 (예: "손흥민 골.mp4" → "손흥민 골")
// 2) 없으면 영상 장면을 기기 안의 이미지 분류 모델(MobileNet v1, ImageNet 1000종)로 보고 넓은 주제로 묶음
//    (예: 축구공·잔디 → 축구, 해변 → 바다, 강아지 품종들 → 강아지). 모델(약 5MB)은 이때만 받습니다.

import { disposeVideo, loadVideo, seek } from "./analyze";
import { isTextAllowed } from "./moderation";
import { withTimeout } from "./net";

export interface InferredTopic {
  /** 검색·해석에 쓸 말 */
  term: string;
  /** 화면에 보여 줄 이름 */
  label: string;
  source: "filename" | "vision" | "features";
  /** 0~1 (파일 이름이면 1) */
  confidence: number;
}

const MODEL_URL = "/models/mobilenet/model.json";
const SIZE = 224;
/** 영상마다 볼 장면 수 */
const FRAMES_PER_VIDEO = 4;
/** 이보다 확신이 낮으면 주제를 고르지 않습니다(엉뚱한 영상을 찾지 않게) */
export const MIN_CONFIDENCE = 0.2;

// ---------------------------------------------------------------------------
// 파일 이름

/** 카메라·앱이 붙이는 이름(IMG_1234, VID_2024..., KakaoTalk_..., Screen_Recording)과 뜻 없는 말 */
const GENERIC_WORD = /^(?:img|vid|mov|mp4|pxl|dsc|dscn|dscf|mvi|gopr|gp|dji|video|videos|clip|clips|movie|screen|recording|record|screenrecord|screenrecording|capture|kakaotalk|snapchat|instagram|insta|tiktok|reels?|shorts?|youtube|download|downloaded|edit|edited|final|copy|untitled|new|trim|trimmed|export|output|file|녹화|화면|화면녹화|동영상|영상|카톡|복사본|편집|최종|다운로드)$/i;

/** 무엇을 찍은 영상인지(장면 종류)를 말하는 말 — 주제(누구·무엇)가 아니므로 주제에서 뺍니다. 예: "손흥민 골 장면" → "손흥민" */
const CONTEXT_WORD = /^(?:골|득점|장면|명장면|모음|하이라이트|직캠|무대|클립|경기|풀영상|풀버전|레전드|모먼트|순간|브이로그|편집본|영상들|highlights?|goals?|compilation|best|moments?|clips?|vlog|part|ep|episode|full|edit|fancam|cut|scenes?|skills?|tribute)$/i;

function nameWords(name: string): string[] {
  return name
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/\(\d+\)|\[\d+\]/g, " ")
    .split(/[\s_\-.,+()[\]{}~!@#$%^&=]+/)
    .map(word => word.trim())
    // 한글은 한 글자도 뜻이 있을 수 있어(개, 산) 남기고, 로마자는 두 글자부터.
    .filter(word => (word.length >= 2 || /[가-힣]/.test(word)) && !CONTEXT_WORD.test(word) && !/^\d+$/.test(word) && !/^\d+[a-z]{0,3}$/i.test(word) && !/^[a-f0-9]{8,}$/i.test(word) && !GENERIC_WORD.test(word));
}

/** 파일 이름에서 주제를 고릅니다. 여러 파일이면 절반 이상에 나오는 말, 하나면 그 이름(최대 4단어). */
export function topicFromFileNames(names: string[]): string | null {
  const lists = names.map(nameWords).filter(words => words.length);
  if (!lists.length) return null;
  let topic: string | null = null;
  if (names.length === 1) topic = lists[0].slice(0, 4).join(" ");
  else {
    const counts = new Map<string, { word: string; count: number }>();
    for (const words of lists) {
      for (const word of new Set(words.map(w => w.toLowerCase()))) {
        const entry = counts.get(word) ?? { word: words.find(w => w.toLowerCase() === word)!, count: 0 };
        entry.count++;
        counts.set(word, entry);
      }
    }
    const best = [...counts.values()].sort((a, b) => b.count - a.count || b.word.length - a.word.length)[0];
    if (best && best.count >= Math.ceil(names.length / 2)) topic = best.word;
  }
  return topic && isTextAllowed(topic) ? topic : null;
}

// ---------------------------------------------------------------------------
// 장면 → 넓은 주제

interface Category {
  term: string;
  label: string;
  /** ImageNet 분류 번호 (구간은 [시작, 끝]) */
  classes: (number | [number, number])[];
}

/** ImageNet 1000종을 에딧 주제로 쓸 만한 넓은 묶음으로 */
export const CATEGORIES: Category[] = [
  { term: "dog", label: "강아지", classes: [[151, 268]] },
  { term: "cat", label: "고양이", classes: [[281, 285]] },
  { term: "wild animals", label: "야생 동물", classes: [[286, 299], [340, 364], [385, 388]] },
  { term: "bird", label: "새", classes: [[7, 24], [80, 100], [127, 146]] },
  { term: "ocean", label: "바다", classes: [[0, 6], [107, 126], [147, 150], [389, 397], 973, 977, 978] },
  { term: "football", label: "축구", classes: [805] },
  { term: "basketball", label: "농구", classes: [430] },
  { term: "volleyball", label: "배구", classes: [890] },
  { term: "baseball", label: "야구", classes: [429] },
  { term: "rugby", label: "럭비", classes: [768] },
  { term: "tennis", label: "테니스", classes: [852] },
  { term: "golf", label: "골프", classes: [574, 575] },
  { term: "ice hockey", label: "아이스하키", classes: [746] },
  { term: "boxing", label: "복싱", classes: [747] },
  { term: "gymnastics", label: "체조", classes: [416, 602, 702] },
  { term: "fitness", label: "헬스", classes: [422, 543] },
  { term: "skiing", label: "스키", classes: [795, 802] },
  { term: "car racing", label: "자동차 경주", classes: [751, 817, 511, 573, 479, 518] },
  { term: "motorcycle", label: "오토바이", classes: [665, 670] },
  { term: "mountain", label: "산", classes: [970, 972, 976, 979, 980] },
  { term: "lake", label: "호수", classes: [975] },
  { term: "city", label: "도시", classes: [468, 829, 874, 920, 779, 864] },
  { term: "rocket launch", label: "로켓 발사", classes: [812, 744, 657] },
  { term: "airplane", label: "비행기", classes: [404, 895, 908] },
  { term: "concert", label: "공연", classes: [819, 402, 546, 541, 776, 579, 650] },
  { term: "train", label: "기차", classes: [466, 820, 565] },
  { term: "ship", label: "배", classes: [510, 628, 814, 484, 914, 554] },
  { term: "food", label: "음식", classes: [[923, 969]] },
];

const CLASS_TO_CATEGORY = (() => {
  const map = new Map<number, number>();
  CATEGORIES.forEach((category, c) => {
    for (const item of category.classes) {
      const [from, to] = Array.isArray(item) ? item : [item, item];
      for (let i = from; i <= to; i++) map.set(i, c);
    }
  });
  return map;
})();

/** 장면마다 특징 문장이 말한 대상(묶음 term들)이 보일 확률의 합 (0~1) */
export function subjectProbability(probs: ArrayLike<number>, terms: string[]): number {
  const wanted = new Set(CATEGORIES.map((category, c) => (terms.includes(category.term) ? c : -1)).filter(c => c >= 0));
  let sum = 0;
  for (let i = 0; i < probs.length; i++) {
    const c = CLASS_TO_CATEGORY.get(i);
    if (c !== undefined && wanted.has(c)) sum += probs[i];
  }
  return Math.min(1, sum);
}

/** 장면들에 특징 문장이 말한 대상이 얼마나 보이는지 */
/**
 * 장면들의 "상대편과 닮은 정도"와 "말한 대상이 보이는 정도"를 모델 한 번으로 함께 잽니다.
 * target이 없으면 닮은 정도는, terms가 비면 대상은 건너뜁니다.
 */
export async function frameScores(frames: HTMLCanvasElement[], target: ArrayLike<number> | null, terms: string[], similarity: (a: ArrayLike<number>, b: ArrayLike<number>) => number) {
  if (!frames.length || (!target && !terms.length)) return { sims: undefined, subjects: undefined };
  const { vectors, probs } = await describeFrames(frames);
  return {
    sims: target ? vectors.map(v => similarity(v, target)) : undefined,
    subjects: terms.length ? probs.map(p => subjectProbability(p, terms)) : undefined,
  };
}

/** 장면별 분류 확률(1000개)을 묶음별로 더해 평균 내고, 가장 높은 묶음을 고릅니다. */
export function topicFromPredictions(frames: ArrayLike<number>[]): InferredTopic | null {
  if (!frames.length) return null;
  const totals = new Float64Array(CATEGORIES.length);
  for (const probs of frames) {
    for (let i = 0; i < probs.length; i++) {
      const c = CLASS_TO_CATEGORY.get(i);
      if (c !== undefined) totals[c] += probs[i];
    }
  }
  let best = 0;
  for (let c = 1; c < totals.length; c++) if (totals[c] > totals[best]) best = c;
  const confidence = totals[best] / frames.length;
  if (confidence < MIN_CONFIDENCE) return null;
  return { term: CATEGORIES[best].term, label: CATEGORIES[best].label, source: "vision", confidence };
}

// ---------------------------------------------------------------------------
// 모델

type Tensor = { data(): Promise<Float32Array>; dispose(): void; shape: number[] };
type Model = { predict(input: unknown): Tensor | Tensor[] };
/** 분류 직전(전역 평균 풀링)의 특징 벡터 — 장면이 "어떻게 생겼는지"를 512개 숫자로 */
const EMBEDDING_LAYER = "global_average_pooling2d_1";
/** 속도: 특징 벡터와 분류 확률을 한 번 돌려 같이 얻는 모델(두 값이 다 필요할 때 장면을 두 번 넣지 않게) */
let model: Promise<{ tf: typeof import("@tensorflow/tfjs"); both: Model }> | null = null;

function loadModel() {
  model ??= (async () => {
    const tf = await import("@tensorflow/tfjs");
    await tf.ready();
    const layers = await tf.loadLayersModel(MODEL_URL);
    const both = tf.model({ inputs: layers.inputs, outputs: [layers.getLayer(EMBEDDING_LAYER).output, layers.outputs[0]] as never }) as unknown as Model;
    return { tf, both };
  })().catch(error => {
    model = null;
    throw error;
  });
  return model;
}

/** 영상을 올리고 주제를 비워 두면 미리 받아 둡니다(만들기를 누를 때 기다리지 않게). */
export function preloadVision() {
  void loadModel().catch(() => undefined);
}

/** 장면들을 한 번(배치)에 모델에 넣어 특징 벡터와 분류 확률을 함께 얻습니다(입력 -1~1). */
/**
 * 속도: 모델에 넣는 장면 수(배치 크기)가 매번 다르면(4, 10, 12장…) TensorFlow가 GPU 프로그램을 새로 만드는데,
 * 이게 실제 계산보다 훨씬 오래 걸립니다. 그래서 늘 같은 크기(BATCH장)로 묶고 모자라면 마지막 장면을 되풀이해 채웁니다.
 */
const BATCH = 8;

export async function describeFrames(frames: HTMLCanvasElement[]): Promise<{ vectors: Float32Array[]; probs: Float32Array[] }> {
  if (!frames.length) return { vectors: [], probs: [] };
  const { tf, both } = await withTimeout(loadModel(), 60_000);
  const vectors: Float32Array[] = [];
  const probs: Float32Array[] = [];
  for (let start = 0; start < frames.length; start += BATCH) {
    const chunk = frames.slice(start, start + BATCH);
    const padded = [...chunk, ...Array.from({ length: BATCH - chunk.length }, () => chunk[chunk.length - 1])];
    const input = tf.tidy(() => tf.stack(padded.map(frame => tf.browser.fromPixels(frame).toFloat().div(127.5).sub(1))));
    const [embedding, prediction] = both.predict(input) as Tensor[];
    const split = async (tensor: Tensor) => {
      const size = tensor.shape[tensor.shape.length - 1];
      const flat = await tensor.data();
      tensor.dispose();
      return chunk.map((_, f) => flat.slice(f * size, (f + 1) * size));
    };
    const [v, p] = await Promise.all([split(embedding), split(prediction)]);
    input.dispose();
    vectors.push(...v);
    probs.push(...p.map(toProbabilities));
  }
  return { vectors, probs };
}

/** 출력이 확률이 아니면 softmax로 바꿉니다. */
function toProbabilities(values: Float32Array): Float32Array {
  let sum = 0;
  for (const p of values) sum += p;
  if (Math.abs(sum - 1) <= 0.05) return values;
  const max = Math.max(...values);
  const exp = values.map(v => Math.exp(v - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / total);
}

/** 224×224 장면들의 특징 벡터 (한 번에 배치로). 장면끼리 닮은 정도를 잴 때 씁니다. */
export async function embed(frames: HTMLCanvasElement[]): Promise<Float32Array[]> {
  return (await describeFrames(frames)).vectors;
}

/** 올린 영상들의 장면 (영상마다 4장면, 가운데 정사각형) */
export async function uploadFrames(files: File[], signal?: AbortSignal): Promise<HTMLCanvasElement[]> {
  const frames: HTMLCanvasElement[] = [];
  for (const file of files.slice(0, 6)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    frames.push(...(await grabFrames(file, signal).catch(() => [])));
  }
  return frames;
}

/**
 * 썸네일 이미지를 224×224 장면으로. 다른 사이트 이미지가 그림을 읽지 못하게 막으면(CORS) null —
 * 그 후보는 닮은 정도를 모르는 것으로 둡니다.
 */
export function posterFrame(url: string, timeoutMs = 4000): Promise<HTMLCanvasElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (value: HTMLCanvasElement | null) => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      resolve(value);
    };
    image.onload = () => {
      try {
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        if (!side) return finish(null);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
        ctx.getImageData(0, 0, 1, 1); // 읽을 수 없으면 여기서 오류
        finish(canvas);
      } catch {
        finish(null);
      }
    };
    image.onerror = () => finish(null);
    image.src = url;
  });
}

/** 224×224 장면들을 한 번에(배치로) 분류합니다. */
async function classify(frames: HTMLCanvasElement[]): Promise<Float32Array[]> {
  return (await describeFrames(frames)).probs;
}

/** 속도: 같은 파일의 장면은 한 번만 뽑습니다(주제 고르기와 닮은 정도 재기에서 함께 씀). 파일이 사라지면 같이 지워짐. */
const grabbed = new WeakMap<File, Promise<HTMLCanvasElement[]>>();

/** 영상에서 고르게 몇 장면을 뽑아 가운데를 정사각형으로 잘라 둡니다. */
function grabFrames(file: File, signal?: AbortSignal): Promise<HTMLCanvasElement[]> {
  let frames = grabbed.get(file);
  if (!frames) {
    frames = grabFramesOnce(file, signal);
    grabbed.set(file, frames);
    // 중단·실패한 결과는 기억하지 않고 다음에 다시 뽑습니다.
    frames.catch(() => grabbed.delete(file));
  }
  return frames;
}

async function grabFramesOnce(file: File, signal?: AbortSignal): Promise<HTMLCanvasElement[]> {
  const url = URL.createObjectURL(file);
  let video: HTMLVideoElement | null = null;
  try {
    video = await loadVideo(url, signal);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration) return [];
    const frames: HTMLCanvasElement[] = [];
    for (let k = 1; k <= FRAMES_PER_VIDEO; k++) {
      await seek(video, (duration * k) / (FRAMES_PER_VIDEO + 1));
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) continue;
      const side = Math.min(vw, vh);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      canvas.getContext("2d")!.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, SIZE, SIZE);
      frames.push(canvas);
    }
    return frames;
  } finally {
    if (video) disposeVideo(video);
    URL.revokeObjectURL(url);
  }
}

/** 올린 영상들에서 주제를 고릅니다. 고르지 못하면 null (그러면 지금처럼 올린 영상만으로 만듦). */
export async function inferTopic(files: File[], signal?: AbortSignal): Promise<InferredTopic | null> {
  const fromName = topicFromFileNames(files.map(file => file.name));
  if (fromName) return { term: fromName, label: fromName, source: "filename", confidence: 1 };
  // 장면을 뽑는 동안 모델도 받습니다.
  preloadVision();
  const frames = await uploadFrames(files, signal);
  if (!frames.length) return null;
  try {
    return topicFromPredictions(await classify(frames));
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
