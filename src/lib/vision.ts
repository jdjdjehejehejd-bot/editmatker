// 주제를 비우고 영상만 올렸을 때, 올린 영상과 비슷한 주제를 알아서 고릅니다.
// 1) 파일 이름에 뜻있는 말이 있으면 그 말 (예: "손흥민 골.mp4" → "손흥민 골")
// 2) 없으면 영상 장면을 기기 안의 이미지 분류 모델(MobileNet v1, ImageNet 1000종)로 보고 넓은 주제로 묶음
//    (예: 축구공·잔디 → 축구, 해변 → 바다, 강아지 품종들 → 강아지). 모델(약 5MB)은 이때만 받습니다.

import { disposeVideo, loadVideo, seek } from "./analyze";
import { isTextAllowed } from "./moderation";

export interface InferredTopic {
  /** 검색·해석에 쓸 말 */
  term: string;
  /** 화면에 보여 줄 이름 */
  label: string;
  source: "filename" | "vision";
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

type Model = { predict(input: unknown): { data(): Promise<Float32Array>; dispose(): void; shape: number[] } };
let model: Promise<{ tf: typeof import("@tensorflow/tfjs"); net: Model }> | null = null;

function loadModel() {
  model ??= (async () => {
    const tf = await import("@tensorflow/tfjs");
    await tf.ready();
    const net = (await tf.loadLayersModel(MODEL_URL)) as unknown as Model;
    return { tf, net };
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

/** 224×224 장면들을 한 번에(배치로) 분류합니다(입력 -1~1). 출력이 확률이 아니면 softmax로 바꿉니다. */
async function classify(frames: HTMLCanvasElement[]): Promise<Float32Array[]> {
  const { tf, net } = await loadModel();
  const input = tf.tidy(() => tf.stack(frames.map(frame => tf.browser.fromPixels(frame).toFloat().div(127.5).sub(1))));
  const output = net.predict(input);
  const classes = output.shape[output.shape.length - 1];
  const flat = await output.data();
  output.dispose();
  input.dispose();
  return frames.map((_, f) => {
    let probs = flat.slice(f * classes, (f + 1) * classes);
    let sum = 0;
    for (const p of probs) sum += p;
    if (Math.abs(sum - 1) > 0.05) {
      const max = Math.max(...probs);
      const exp = probs.map(v => Math.exp(v - max));
      const total = exp.reduce((a, b) => a + b, 0);
      probs = exp.map(v => v / total);
    }
    return probs;
  });
}

/** 영상에서 고르게 몇 장면을 뽑아 가운데를 정사각형으로 잘라 둡니다. */
async function grabFrames(file: File, signal?: AbortSignal): Promise<HTMLCanvasElement[]> {
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
  const frames: HTMLCanvasElement[] = [];
  for (const file of files.slice(0, 6)) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    frames.push(...(await grabFrames(file, signal).catch(() => [])));
  }
  if (!frames.length) return null;
  try {
    return topicFromPredictions(await classify(frames));
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
