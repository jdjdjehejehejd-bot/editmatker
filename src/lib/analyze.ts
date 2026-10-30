// 내려받은 영상을 브라우저에서 훑어 프레임별 움직임·색·소리 세기를 측정합니다.

import { detectCuts, type FrameSample } from "./highlights";

const W = 64;
const H = 36;
const DEFAULT_MAX_SAMPLES = 240;

export interface VideoAnalysis {
  duration: number;
  width: number;
  height: number;
  samples: FrameSample[];
  /** 검열용 장면(224×224). 검사가 끝나면 비웁니다. */
  keyframes: HTMLCanvasElement[];
}

/** 영상마다 검열에 쓸 장면 수 */
const KEYFRAMES = 10;
const KEYFRAME_SIZE = 224;

const LOAD_TIMEOUT_MS = 20_000;

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
    const onLoaded = () => finish();
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

export function seek(video: HTMLVideoElement, time: number): Promise<void> {
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

async function audioEnvelope(blob: Blob, times: number[], step: number): Promise<number[]> {
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    return times.map(t => {
      const from = Math.max(0, Math.floor(t * rate));
      const to = Math.min(data.length, Math.floor((t + step) * rate));
      let sum = 0;
      for (let i = from; i < to; i += 8) sum += data[i] * data[i];
      return Math.sqrt(sum / Math.max(1, (to - from) / 8));
    });
  } catch {
    // 소리가 없거나 디코딩할 수 없는 영상
    return times.map(() => 0);
  }
}

export async function analyzeVideo(
  blob: Blob,
  url: string,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
  maxSamples = DEFAULT_MAX_SAMPLES,
  /** 장면 사이 최소 간격(초). 빠른 컷을 세려는 참고 에딧 분석은 더 촘촘하게 봅니다. */
  minStep = 0.25
): Promise<VideoAnalysis> {
  const video = await loadVideo(url, signal);
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration < 2) throw new Error("영상이 너무 짧아요.");
  const step = Math.max(minStep, duration / maxSamples);
  const times: number[] = [];
  for (let t = 0; t < duration - 0.1; t += step) times.push(t);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const audioPromise = audioEnvelope(blob, times, step);

  const raw: Omit<FrameSample, "cut" | "audio">[] = [];
  // 전체 길이에 고르게 퍼진 장면을 검열용으로 따로 담아 둡니다.
  const keyframeAt = new Set(Array.from({ length: Math.min(KEYFRAMES, times.length) }, (_, k) => Math.floor(((k + 0.5) * times.length) / Math.min(KEYFRAMES, times.length))));
  const keyframes: HTMLCanvasElement[] = [];
  let previous: Float32Array | null = null;
  for (let i = 0; i < times.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await seek(video, times[i]);
    ctx.drawImage(video, 0, 0, W, H);
    if (keyframeAt.has(i)) {
      const frame = document.createElement("canvas");
      frame.width = frame.height = KEYFRAME_SIZE;
      frame.getContext("2d")!.drawImage(video, 0, 0, KEYFRAME_SIZE, KEYFRAME_SIZE);
      keyframes.push(frame);
    }
    const pixels = ctx.getImageData(0, 0, W, H).data;
    const luma = new Float32Array(W * H);
    let sumL = 0;
    let sumL2 = 0;
    let sumS = 0;
    for (let p = 0, j = 0; p < pixels.length; p += 4, j++) {
      const r = pixels[p] / 255;
      const g = pixels[p + 1] / 255;
      const b = pixels[p + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[j] = l;
      sumL += l;
      sumL2 += l * l;
      const max = Math.max(r, g, b);
      sumS += max ? (max - Math.min(r, g, b)) / max : 0;
    }
    const n = W * H;
    const mean = sumL / n;
    const contrast = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
    let motion = 0;
    if (previous) {
      for (let j = 0; j < n; j++) motion += Math.abs(luma[j] - previous[j]);
      motion /= n;
    }
    previous = luma;
    raw.push({ t: times[i], motion, color: Math.min(1, (sumS / n) * contrast * 4), brightness: mean });
    onProgress((i + 1) / times.length);
  }

  const audio = await audioPromise;
  const cuts = detectCuts(raw.map(r => r.motion));
  const samples = raw.map((r, i) => ({ ...r, audio: audio[i] ?? 0, cut: cuts[i] }));
  const result = { duration, width: video.videoWidth, height: video.videoHeight, samples, keyframes };
  disposeVideo(video);
  return result;
}
