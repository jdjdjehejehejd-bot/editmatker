// 편집 계획을 캔버스에 실시간으로 그리고 MediaRecorder로 영상 파일을 만듭니다.

import { seek } from "./analyze";
import type { EditPlan, Segment } from "./plan";
import type { EditStyle, Grade } from "./style";

export type Aspect = "9:16" | "16:9" | "1:1";

export const ASPECT_SIZE: Record<Aspect, [number, number]> = {
  "9:16": [720, 1280],
  "16:9": [1280, 720],
  "1:1": [1080, 1080],
};

export const CREDIT_SECONDS = 3;
const POOL_SIZE = 4;

const GRADE_FILTER: Record<Grade, string> = {
  natural: "contrast(1.05) saturate(1.05)",
  warm: "sepia(0.22) saturate(1.3) contrast(1.08) brightness(1.03)",
  cool: "saturate(0.85) hue-rotate(-12deg) contrast(1.12) brightness(0.98)",
  mono: "grayscale(1) contrast(1.35) brightness(1.02)",
  vivid: "saturate(1.6) contrast(1.15)",
  "teal-orange": "contrast(1.15) saturate(1.25)",
};

// ctx.filter를 지원하지 않는 브라우저(Safari)용 색 보정 레이어
const GRADE_TINT: Record<Grade, [GlobalCompositeOperation, string][]> = {
  natural: [],
  warm: [["soft-light", "rgba(255,150,60,0.28)"]],
  cool: [["soft-light", "rgba(60,130,255,0.28)"]],
  mono: [["saturation", "rgb(128,128,128)"]],
  vivid: [["soft-light", "rgba(255,0,140,0.12)"]],
  "teal-orange": [],
};

export interface RenderSource {
  id: string;
  url: string;
}

export interface RenderOptions {
  canvas: HTMLCanvasElement;
  plan: EditPlan;
  style: EditStyle;
  sources: RenderSource[];
  title: string;
  subtitle: string;
  credits: string[];
  music: { buffer: AudioBuffer; offset: number };
  /** 미리 깨워 둔 AudioContext (iOS는 버튼을 누를 때 만든 것만 소리가 남) */
  audio?: AudioContext;
  onProgress: (ratio: number) => void;
  signal?: AbortSignal;
}

export function pickMimeType(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "video/webm";
}

function makeGrain(): HTMLCanvasElement {
  const grain = document.createElement("canvas");
  grain.width = grain.height = 256;
  const g = grain.getContext("2d")!;
  const image = g.createImageData(256, 256);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.random() * 255;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  g.putImageData(image, 0, 0);
  return grain;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderEdit(options: RenderOptions): Promise<{ blob: Blob; mimeType: string }> {
  const { canvas, plan, style, signal } = options;
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  const supportsFilter = "filter" in ctx && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const grain = style.effects.has("grain") ? makeGrain() : null;
  const vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.55)");
  const urls = new Map(options.sources.map(s => [s.id, s.url]));
  const beat = 60 / plan.bpm;
  const total = plan.duration + CREDIT_SECONDS;
  const font = `"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif`;

  // 재생기 풀: 지금 컷이 재생되는 동안 다음 컷들을 미리 찾아 둡니다.
  const pool = Array.from({ length: POOL_SIZE }, () => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    return v;
  });
  const prepared: Promise<void>[] = [];
  const prepare = (index: number) => {
    const seg = plan.segments[index];
    if (!seg) return;
    const video = pool[index % POOL_SIZE];
    const url = urls.get(seg.sourceId)!;
    prepared[index] = (async () => {
      if (video.src !== url) {
        video.src = url;
        await new Promise<void>(resolve => {
          if (video.readyState >= 1) return resolve();
          video.addEventListener("loadedmetadata", () => resolve(), { once: true });
          video.addEventListener("error", () => resolve(), { once: true });
        });
      }
      video.pause();
      await seek(video, Math.min(seg.srcStart, Math.max(0, video.duration - 0.2)));
      video.playbackRate = seg.rate;
    })();
  };
  for (let i = 0; i < POOL_SIZE - 1; i++) prepare(i);
  await Promise.all(prepared.slice(0, POOL_SIZE - 1));

  const audio = options.audio ?? new AudioContext();
  await audio.resume().catch(() => undefined);
  const destination = audio.createMediaStreamDestination();
  const musicSource = audio.createBufferSource();
  musicSource.buffer = options.music.buffer;
  const musicGain = audio.createGain();
  musicSource.connect(musicGain);
  musicGain.connect(destination);
  musicGain.connect(audio.destination);

  const stream = canvas.captureStream(30);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()));

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  recorder.start(500);
  const t0 = audio.currentTime + 0.15;
  // 오디오가 끝내 깨어나지 않으면(일부 모바일 브라우저) 시계가 멈추므로 실제 시간으로 대신 잽니다.
  const wallStart = performance.now() + 150;
  const clock = () => (audio.state === "running" ? audio.currentTime - t0 : (performance.now() - wallStart) / 1000);
  musicSource.start(t0, options.music.offset);
  // 음악이 편집보다 길면 크레딧 끝에서 페이드아웃
  musicGain.gain.setValueAtTime(1, t0 + total - 2);
  musicGain.gain.linearRampToValueAtTime(0, t0 + total);

  let current = -1;

  const drawVideo = (seg: Segment, video: HTMLVideoElement, now: number) => {
    const local = now - seg.start;
    const p = Math.min(1, local / seg.duration);
    const beatPhase = (((now - plan.beatOffset) / beat) % 1 + 1) % 1;
    let zoom = seg.zoom === "in" ? 1 + 0.12 * p : seg.zoom === "out" ? 1.12 - 0.12 * p : 1.02;
    if (style.effects.has("pulse") && seg.section === "drop") zoom += 0.04 * Math.exp(-beatPhase * 6);
    let dx = 0;
    let dy = 0;
    if (seg.shake) {
      const amp = 14 * Math.exp(-beatPhase * 7);
      dx = (Math.random() - 0.5) * amp;
      dy = (Math.random() - 0.5) * amp;
    }
    const vw = video.videoWidth || W;
    const vh = video.videoHeight || H;
    const scale = Math.max(W / vw, H / vh) * zoom;
    const w = vw * scale;
    const h = vh * scale;
    ctx.save();
    if (supportsFilter) ctx.filter = GRADE_FILTER[style.grade];
    if (video.readyState >= 2) ctx.drawImage(video, (W - w) / 2 + dx, (H - h) / 2 + dy, w, h);
    ctx.restore();

    if (seg.glitch && local < 0.4) {
      for (let i = 0; i < 7; i++) {
        const y = Math.random() * H;
        const band = 8 + Math.random() * 40;
        const shift = (Math.random() - 0.5) * 80;
        ctx.drawImage(canvas, 0, y, W, band, shift, y, W, band);
      }
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = 0.35;
      ctx.drawImage(canvas, 6, 0, W, H);
      ctx.fillStyle = "rgba(255,0,80,0.12)";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  };

  const drawOverlays = (seg: Segment | null, now: number) => {
    ctx.save();
    if (!supportsFilter) {
      for (const [op, color] of GRADE_TINT[style.grade]) {
        ctx.globalCompositeOperation = op;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, W, H);
      }
    }
    if (style.grade === "teal-orange") {
      ctx.globalCompositeOperation = "soft-light";
      const tint = ctx.createLinearGradient(0, 0, 0, H);
      tint.addColorStop(0, "rgba(0,140,150,0.35)");
      tint.addColorStop(1, "rgba(255,130,40,0.3)");
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
    if (grain) {
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = 0.12;
      const ox = Math.random() * 256;
      const oy = Math.random() * 256;
      for (let x = -ox; x < W; x += 256) for (let y = -oy; y < H; y += 256) ctx.drawImage(grain, x, y);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    if (style.effects.has("letterbox")) {
      const bar = H * (W > H ? 0.1 : 0.06);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
    }
    if (seg?.flash) {
      const local = now - seg.start;
      if (local < 0.2) {
        ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - local / 0.2)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    // 인트로 타이틀
    const titleEnd = plan.dropAt - 0.15;
    if (now < titleEnd) {
      const alpha = Math.min(1, now / 0.6, (titleEnd - now) / 0.4);
      const size = Math.round(Math.min(W, H) * 0.11);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `800 ${size}px ${font}`;
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 24;
      ctx.fillStyle = "#fff";
      const lines = wrapText(ctx, options.title.toUpperCase(), W * 0.86);
      lines.forEach((line, i) => ctx.fillText(line, W / 2, H * 0.5 + (i - (lines.length - 1) / 2) * size * 1.1));
      ctx.font = `700 ${Math.round(size * 0.3)}px ${font}`;
      ctx.fillStyle = "#ffd2c6";
      ctx.fillText(options.subtitle, W / 2, H * 0.5 + ((lines.length + 1) / 2) * size * 1.1);
      ctx.globalAlpha = 1;
    }
    // 시작 페이드인
    if (now < 0.3) {
      ctx.fillStyle = `rgba(0,0,0,${1 - now / 0.3})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  };

  const drawCredits = (now: number) => {
    const local = now - plan.duration;
    ctx.save();
    ctx.fillStyle = "#0d0d0c";
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = Math.min(1, local / 0.4);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const size = Math.round(Math.min(W, H) * 0.034);
    ctx.fillStyle = "#f26a4b";
    ctx.font = `700 ${size * 1.3}px ${font}`;
    let y = H * 0.3;
    ctx.fillText("SOURCES", W / 2, y);
    y += size * 2.6;
    ctx.fillStyle = "#e9e7df";
    ctx.font = `500 ${size}px ${font}`;
    for (const credit of options.credits.slice(0, 8)) {
      for (const line of wrapText(ctx, credit, W * 0.84)) {
        ctx.fillText(line, W / 2, y);
        y += size * 1.45;
      }
      y += size * 0.6;
    }
    ctx.fillStyle = "#8b8d85";
    ctx.fillText("made with editmatker", W / 2, H * 0.88);
    ctx.restore();
  };

  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) {
        void audio.close().catch(() => undefined);
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const now = clock();
      if (now >= total) return resolve();
      if (now >= 0) {
        if (now < plan.duration) {
          let index = current < 0 ? 0 : current;
          while (index < plan.segments.length - 1 && now >= plan.segments[index + 1].start) index++;
          if (index !== current) {
            if (current >= 0) pool[current % POOL_SIZE].pause();
            current = index;
            const video = pool[index % POOL_SIZE];
            void prepared[index]?.then(() => video.play().catch(() => undefined));
            prepare(current + POOL_SIZE - 1);
          }
          const seg = plan.segments[current];
          drawVideo(seg, pool[current % POOL_SIZE], now);
          drawOverlays(seg, now);
        } else {
          pool.forEach(v => v.pause());
          drawCredits(now);
        }
        options.onProgress(Math.min(1, now / total));
      }
      if (document.hidden) setTimeout(tick, 33);
      else requestAnimationFrame(tick);
    };
    tick();
  }).finally(() => {
    try {
      musicSource.stop();
    } catch {
      /* 이미 멈춤 */
    }
    if (recorder.state !== "inactive") recorder.stop();
    pool.forEach(v => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
  });

  await stopped;
  await audio.close().catch(() => undefined);
  options.onProgress(1);
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), mimeType };
}
