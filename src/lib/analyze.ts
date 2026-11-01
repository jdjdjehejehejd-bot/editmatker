// 내려받은 영상을 브라우저에서 훑어 프레임별 움직임·색·소리 세기를 측정합니다.

import { contentBox, interestPoint, type ContentBox } from "./framing";
import { detectCuts, pickRegions, type FrameSample } from "./highlights";
import { residualMotion } from "./framing";

const W = 64;
const H = 36;
const DEFAULT_MAX_SAMPLES = 240;

export interface VideoAnalysis {
  duration: number;
  width: number;
  height: number;
  /** 장면 샘플. 긴 영상은 촘촘히 다시 본 구간들의 샘플(구간 첫 샘플에 gap) */
  samples: FrameSample[];
  /** 긴 영상을 두 번에 나눠 봤을 때 처음 전체를 훑은 샘플 — 영상 전체가 얼마나 살아 있는지 잴 때 씀 */
  overview?: FrameSample[];
  /** 검은 띠(레터박스·필러박스)를 뺀 실제 화면 영역 (0~1) */
  content?: ContentBox;
  /** 검열용 장면(224×224). 검사가 끝나면 비웁니다. */
  keyframes: HTMLCanvasElement[];
  /** 각 검열용 장면의 시각(초) — 장면별 닮은 정도를 샘플에 옮길 때 씀 */
  keyframeTimes?: number[];
}

/** 영상마다 검열에 쓸 장면 수 */
const KEYFRAMES = 10;
const KEYFRAME_SIZE = 224;

const LOAD_TIMEOUT_MS = 20_000;
/** 이보다 큰 파일은 소리 세기를 재지 않습니다 — 파일 전체를 메모리에 올려 풀어야 해서 휴대폰이 멈출 수 있음 */
const MAX_AUDIO_DECODE_BYTES = 120 * 1024 * 1024;

/**
 * 화면 밖에 숨긴 video 요소를 만듭니다. iOS Safari는 문서에 붙지 않았거나 한 번도 재생하지 않은
 * 영상은 데이터를 받지 않아서, 화면에 붙인 뒤 잠깐 재생했다 멈춰 데이터를 받게 합니다.
 */
export function createHiddenVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.preload = "auto";
  video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  return video;
}

export function disposeVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.remove();
}

export function loadVideo(url: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = createHiddenVideo();
    let settled = false;
    let measuring = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("canplay", onLoaded);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        disposeVideo(video);
        reject(error);
      } else {
        video.pause();
        resolve(video);
      }
    };
    const onLoaded = () => {
      // 휴대폰·화면 녹화(MediaRecorder) WebM은 끝까지 훑기 전에는 길이를 Infinity로 알려 줍니다.
      // 끝으로 한 번 건너뛰면 브라우저가 실제 길이를 계산하므로, 그다음 처음으로 돌려놓고 씁니다.
      if (video.duration === Infinity) {
        // loadeddata·canplay가 둘 다 와도 한 번만 합니다.
        if (!measuring) {
          measuring = true;
          resolveDuration(video).then(() => finish(), () => finish());
        }
        return;
      }
      finish();
    };
    const onMetadata = () => {
      // iOS: 재생을 한 번 시작해야 프레임 데이터를 받습니다.
      void video.play().then(() => video.pause(), () => undefined);
    };
    const onError = () => {
      const code = video.error?.code;
      finish(new Error(code === 4 ? "이 브라우저에서 재생할 수 없는 영상 형식이에요." : `영상을 열지 못했어요 (오류 ${code ?? "?"})`));
    };
    const onAbort = () => finish(new DOMException("Aborted", "AbortError") as unknown as Error);
    const timer = setTimeout(() => finish(new Error("영상을 여는 데 너무 오래 걸려요.")), LOAD_TIMEOUT_MS);
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("canplay", onLoaded);
    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort);
    video.src = url;
    video.load();
  });
}

/** 길이가 Infinity인 영상의 실제 길이를 알아냅니다(최대 5초 기다림). */
function resolveDuration(video: HTMLVideoElement): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener("durationchange", check);
      video.removeEventListener("timeupdate", check);
      video.currentTime = 0;
      resolve();
    };
    const check = () => {
      if (Number.isFinite(video.duration)) done();
    };
    const timer = setTimeout(done, 5000);
    video.addEventListener("durationchange", check);
    video.addEventListener("timeupdate", check);
    video.currentTime = 1e7;
  });
}

export function seek(video: HTMLVideoElement, time: number): Promise<void> {
  // 길이를 아직 모르는 영상(NaN·Infinity)에서 계산한 위치는 숫자가 아닐 수 있어 그대로 넣으면 오류가 납니다
  // ("Failed to set the 'currentTime' property … non-finite"). 이때는 처음으로, 길이를 알면 그 안으로 맞춥니다.
  if (!Number.isFinite(time)) time = 0;
  if (Number.isFinite(video.duration) && video.duration > 0) time = Math.min(time, Math.max(0, video.duration - 0.05));
  time = Math.max(0, time);
  return new Promise(resolve => {
    if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2) return resolve();
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      resolve();
    };
    // 일부 브라우저는 seeked를 놓치므로 시간 제한을 둡니다.
    const timer = setTimeout(done, 3000);
    video.addEventListener("seeked", done);
    video.currentTime = time;
  });
}

/** 소리 세기(RMS)를 아무 구간에서나 잴 수 있게 영상의 소리를 한 번만 풀어 둡니다. 못 풀면 null. */
async function decodeAudio(blob: Blob): Promise<((from: number, to: number) => number) | null> {
  if (blob.size > MAX_AUDIO_DECODE_BYTES) return null;
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    return (fromT, toT) => {
      const from = Math.max(0, Math.floor(fromT * rate));
      const to = Math.min(data.length, Math.floor(toT * rate));
      let sum = 0;
      for (let i = from; i < to; i += 8) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, (to - from) / 8));
    };
  } catch {
    // 소리가 없거나 디코딩할 수 없는 영상
    return null;
  }
}

/** 긴 영상에서 두 번째로 촘촘히 볼 때의 샘플 간격(초) */
const DENSE_STEP = 0.2;
/** 듬성듬성 볼 때 각 지점의 움직임을 재려고 바로 앞에서 한 장 더 보는 간격(초) */
const PAIR_GAP = 0.25;
/** 촘촘히 다시 볼 구간 하나의 길이(초) */
const REGION_SECONDS = 5;
/** 첫 샘플 간격이 이보다 넓으면(긴 영상) 두 번에 나눠 봅니다 */
const REFINE_STEP = 0.6;

export async function analyzeVideo(
  blob: Blob,
  url: string,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
  maxSamples = DEFAULT_MAX_SAMPLES,
  /** 장면 사이 최소 간격(초). 빠른 컷을 세려는 참고 에딧 분석은 더 촘촘하게 봅니다. */
  minStep = 0.25,
  /**
   * 긴 영상을 두 번에 나눠 볼지: 처음엔 전체를 듬성듬성(각 지점은 바로 앞 장면과 비교해 그 순간의 움직임을 잼) 훑고,
   * 볼 만한 곳만 0.2초 간격으로 다시 봅니다. 몇 초 간격으로만 보면 펀치처럼 찰나인 순간을 놓치고 걷기·견제 장면이 고려됨.
   */
  refine: boolean | { wide?: boolean } = false
): Promise<VideoAnalysis> {
  const video = await loadVideo(url, signal);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration < 2) throw new Error("영상이 너무 짧아요.");
  const evenStep = Math.max(minStep, duration / maxSamples);
  const twoPass = refine && evenStep > REFINE_STEP;
  // 두 번에 나눠 보면: 첫 번째는 지점마다 두 장(예산의 2/3), 두 번째는 촘촘히(예산만큼) — 전체로 예산의 1.7배쯤
  const coarseCount = twoPass ? Math.max(20, Math.round(maxSamples / 3)) : maxSamples;
  const step = twoPass ? duration / coarseCount : evenStep;
  const times: number[] = [];
  for (let t = twoPass ? step / 2 : 0; t < duration - 0.1; t += step) times.push(t);
  const regionCount = twoPass ? Math.max(3, Math.floor(maxSamples / (REGION_SECONDS / DENSE_STEP + 2))) : 0;
  const totalSeeks = times.length * (twoPass ? 2 : 1) + regionCount * Math.ceil(REGION_SECONDS / DENSE_STEP + 1);
  let seeks = 0;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const audioPromise = decodeAudio(blob);

  // 전체 길이에 고르게 퍼진 장면을 검열용으로 따로 담아 둡니다.
  const keyframeAt = new Set(Array.from({ length: Math.min(KEYFRAMES, times.length) }, (_, k) => Math.floor(((k + 0.5) * times.length) / Math.min(KEYFRAMES, times.length))));
  const keyframes: HTMLCanvasElement[] = [];
  const keyframeTimes: number[] = [];
  let previous: Float32Array | null = null;
  // 줄·칸마다 가장 밝았던 밝기 — 끝까지 어두운 가장자리는 검은 띠로 봅니다.
  const rowPeak = new Float32Array(H);
  const colPeak = new Float32Array(W);
  const rowSum = new Float32Array(H);
  const colSum = new Float32Array(W);
  /** time의 장면을 재고, 바로 앞에 잰 장면(previous)과 비교해 움직임을 냅니다. record=false면 비교 기준만 잡음. */
  const measure = async (time: number, keyframe: boolean): Promise<Omit<FrameSample, "cut" | "audio">> => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await seek(video, time);
    ctx.drawImage(video, 0, 0, W, H);
    if (keyframe) {
      const frame = document.createElement("canvas");
      frame.width = frame.height = KEYFRAME_SIZE;
      frame.getContext("2d")!.drawImage(video, 0, 0, KEYFRAME_SIZE, KEYFRAME_SIZE);
      keyframes.push(frame);
      keyframeTimes.push(time);
    }
    const pixels = ctx.getImageData(0, 0, W, H).data;
    const luma = new Float32Array(W * H);
    let sumL = 0;
    let sumL2 = 0;
    let sumS = 0;
    let edge = 0;
    let floorBright = 0;
    let floorTotal = 0;
    const floorTop = Math.floor(H / 2);
    const floorBottom = Math.floor(H * 0.88);
    rowSum.fill(0);
    colSum.fill(0);
    for (let p = 0, j = 0; p < pixels.length; p += 4, j++) {
      const r = pixels[p] / 255;
      const g = pixels[p + 1] / 255;
      const b = pixels[p + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[j] = l;
      const x = j % W;
      const y = (j - x) / W;
      rowSum[y] += l;
      colSum[x] += l;
      if (x) edge += Math.abs(l - luma[j - 1]);
      sumL += l;
      sumL2 += l * l;
      const max = Math.max(r, g, b);
      const sat = max ? (max - Math.min(r, g, b)) / max : 0;
      sumS += sat;
      // 경기장 바닥(밝고 색이 옅은 매트) — 아래쪽 절반, 맨 아래 자막·점수 띠는 뺌
      if (y >= floorTop && y < floorBottom) {
        floorTotal++;
        if (l > 0.55 && sat < 0.3) floorBright++;
      }
    }
    const n = W * H;
    for (let y = 0; y < H; y++) rowPeak[y] = Math.max(rowPeak[y], rowSum[y] / W);
    for (let x = 0; x < W; x++) colPeak[x] = Math.max(colPeak[x], colSum[x] / H);
    const mean = sumL / n;
    const contrast = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
    let motion = 0;
    if (previous) {
      for (let j = 0; j < n; j++) motion += Math.abs(luma[j] - previous[j]);
      motion /= n;
    }
    const focus = interestPoint(pixels, luma, previous, W, H);
    // 카메라가 선수를 따라 움직이기만 해도(걷기·견제) 화면 전체가 바뀌어 움직임이 크게 잡히므로,
    // 화면 전체의 이동을 빼고 남은 "실제 동작"을 따로 잽니다.
    const action = previous ? residualMotion(luma, previous, W, H) : 0;
    previous = luma;
    onProgress(Math.min(1, ++seeks / totalSeeks));
    return { t: time, motion, action, color: Math.min(1, (sumS / n) * contrast * 4), brightness: mean, detail: edge / n, floor: floorTotal ? floorBright / floorTotal : 0, focusX: focus.x, focusY: focus.y, presence: focus.presence };
  };

  const raw: Omit<FrameSample, "cut" | "audio">[] = [];
  for (let i = 0; i < times.length; i++) {
    // 두 번에 나눠 볼 때: 바로 앞 장면과 비교해야 그 순간의 움직임이 됩니다(몇 초 떨어진 장면과 비교하면 그냥 다른 장면).
    if (twoPass) {
      previous = null;
      await measure(Math.max(0, times[i] - PAIR_GAP), false);
    }
    raw.push(await measure(times[i], keyframeAt.has(i)));
  }

  const audioAt = await audioPromise;
  const envelope = (list: number[], width: number) => (audioAt ? list.map(t => audioAt(t, t + width)) : list.map(() => 0));
  const cuts = detectCuts(raw.map(r => r.motion));
  const overview: FrameSample[] = raw.map((r, i) => ({ ...r, audio: envelope([r.t], twoPass ? PAIR_GAP : step)[0], cut: cuts[i] }));
  let samples = overview;
  if (twoPass) {
    // 각 지점 근처(앞뒤 반 간격)에서 소리가 가장 크게 튄 정도 — 타격음·함성이 난 곳
    const audioPeak = audioAt
      ? overview.map(s => {
          let value = 0;
          let at = s.t;
          let last = audioAt(Math.max(0, s.t - step / 2 - 0.1), Math.max(0, s.t - step / 2));
          for (let t = Math.max(0, s.t - step / 2); t < Math.min(duration, s.t + step / 2); t += 0.1) {
            const level = audioAt(t, t + 0.1);
            if (level - last > value) {
              value = level - last;
              at = t;
            }
            last = level;
          }
          return { value, at };
        })
      : undefined;
    const regions = pickRegions(overview, duration, REGION_SECONDS, regionCount, audioPeak, typeof refine === "object" && Boolean(refine.wide));
    const dense: FrameSample[] = [];
    for (const region of regions) {
      // 구간 첫 장면도 바로 앞 장면과 비교하도록 한 장 앞에서 시작합니다.
      previous = null;
      await measure(Math.max(0, region.from - DENSE_STEP), false);
      const part: Omit<FrameSample, "cut" | "audio">[] = [];
      for (let t = region.from; t <= region.to; t += DENSE_STEP) part.push(await measure(t, false));
      const partCuts = detectCuts(part.map(r => r.motion));
      part.forEach((r, i) => dense.push({ ...r, audio: envelope([r.t], DENSE_STEP)[0], cut: partCuts[i], ...(i === 0 ? { gap: true } : {}) }));
    }
    if (dense.length) samples = dense;
  }
  onProgress(1);
  const result: VideoAnalysis = {
    duration,
    width: video.videoWidth,
    height: video.videoHeight,
    samples,
    ...(samples !== overview ? { overview } : {}),
    keyframes,
    keyframeTimes,
    content: contentBox(rowPeak, colPeak),
  };
  disposeVideo(video);
  return result;
}
