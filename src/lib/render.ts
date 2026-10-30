// 편집 계획을 캔버스에 실시간으로 그리고 MediaRecorder로 영상 파일을 만듭니다.

import { createHiddenVideo, disposeVideo, seek } from "./analyze";
import { cropOffset, focusAt, smoothTrack, type FocusPoint } from "./framing";
import type { FrameSample } from "./highlights";
import { renderableTexts, TEXT_SIZE_RATIO, textAlpha, textAnchorY, type TextOverlay } from "./overlay";
import type { EditPlan, Segment } from "./plan";
import type { EditStyle, Grade } from "./style";

export type Aspect = "9:16" | "16:9" | "1:1";

export const ASPECT_SIZE: Record<Aspect, [number, number]> = {
  "9:16": [720, 1280],
  "16:9": [1280, 720],
  "1:1": [1080, 1080],
};

export const CREDIT_SECONDS = 3;
/** 출처 화면 없이 끝낼 때 마지막 페이드아웃 길이 */
const END_FADE_SECONDS = 0.5;

/** 출처 화면을 붙이면 편집 뒤에 더해지는 시간 */
export function tailSeconds(showCredits = true) {
  return showCredits ? CREDIT_SECONDS : 0;
}
const POOL_SIZE = 5;
/** 지금 컷 다음 몇 개를 미리 찾아 둘지 — 직전 컷 재생기는 크로스페이드에 쓰도록 비워 둡니다(POOL_SIZE - 2). */
const LOOKAHEAD = POOL_SIZE - 2;
const FADE_SECONDS = 0.35;
const PUNCH_SECONDS = 0.18;
const WHIP_SECONDS = 0.14;

/** 부드러운 시작·끝 (줌이 기계적으로 보이지 않게) */
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

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
  /** 분석 결과가 있으면 관심 지점(사람·움직임)을 따라 화면을 맞춥니다 */
  analysis?: { samples: FrameSample[] };
}

export interface RenderOptions {
  canvas: HTMLCanvasElement;
  plan: EditPlan;
  style: EditStyle;
  sources: RenderSource[];
  title: string;
  subtitle: string;
  credits: string[];
  /** 시작 제목을 그릴지 (기본 true) */
  showTitle?: boolean;
  /** 끝에 출처 화면을 붙일지 (기본 true, 끄면 마지막에 검게 페이드아웃) */
  showCredits?: boolean;
  /** 사용자가 넣은 텍스트 */
  texts?: TextOverlay[];
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
  // 틸 & 오렌지 색 보정 레이어는 매 프레임 만들지 않고 한 번만 만듭니다.
  const tealOrange = ctx.createLinearGradient(0, 0, 0, H);
  tealOrange.addColorStop(0, "rgba(0,140,150,0.35)");
  tealOrange.addColorStop(1, "rgba(255,130,40,0.3)");
  const vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.55)");
  const urls = new Map(options.sources.map(s => [s.id, s.url]));
  // 자동 리프레이밍: 영상마다 관심 지점 경로를 부드럽게 만들어 둡니다(장면 전환을 넘어서 섞이지 않게 컷마다 따로).
  const tracks = new Map<string, FocusPoint[]>(
    options.sources.map(source => {
      const samples = source.analysis?.samples ?? [];
      const shots: FocusPoint[][] = [[]];
      for (const s of samples) {
        if (s.cut && shots[shots.length - 1].length) shots.push([]);
        if (s.focusX !== undefined && s.focusY !== undefined) shots[shots.length - 1].push({ t: s.t, x: s.focusX, y: s.focusY });
      }
      return [source.id, shots.flatMap(shot => smoothTrack(shot))];
    })
  );
  const beat = 60 / plan.bpm;
  const showTitle = options.showTitle !== false;
  const showCredits = options.showCredits !== false;
  const total = plan.duration + tailSeconds(showCredits);
  const font = `"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif`;

  // 속도: 글자 줄바꿈(measureText)은 매 프레임 하지 않고 미리 한 번만 계산합니다.
  const titleSize = Math.round(Math.min(W, H) * 0.11);
  const titleFont = `800 ${titleSize}px ${font}`;
  ctx.font = titleFont;
  const titleLines = showTitle && options.title.trim() ? wrapText(ctx, options.title.toUpperCase(), W * 0.86) : [];
  const creditSize = Math.round(Math.min(W, H) * 0.034);
  ctx.font = `500 ${creditSize}px ${font}`;
  const creditLines = showCredits ? options.credits.slice(0, 8).map(credit => wrapText(ctx, credit, W * 0.84)) : [];
  const texts = renderableTexts(options.texts ?? [], plan.duration).map(text => {
    const size = Math.round(Math.min(W, H) * TEXT_SIZE_RATIO[text.size]);
    const textFont = `800 ${size}px ${font}`;
    ctx.font = textFont;
    return { overlay: text, size, font: textFont, lines: wrapText(ctx, text.text, W * 0.86) };
  });

  // 재생기 풀: 지금 컷이 재생되는 동안 다음 컷들을 미리 찾아 둡니다.
  const pool = Array.from({ length: POOL_SIZE }, createHiddenVideo);
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
  for (let i = 0; i <= LOOKAHEAD; i++) prepare(i);
  await Promise.all(prepared.slice(0, LOOKAHEAD + 1));

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
  /** 크로스페이드 중인 직전 컷 */
  let previous = -1;

  const drawVideo = (seg: Segment, video: HTMLVideoElement, now: number, alpha = 1) => {
    const local = now - seg.start;
    const p = Math.min(1, Math.max(0, local / seg.duration));
    const eased = easeInOut(p);
    const beatPhase = (((now - plan.beatOffset) / beat) % 1 + 1) % 1;
    let zoom = seg.zoom === "in" ? 1 + 0.12 * eased : seg.zoom === "out" ? 1.12 - 0.12 * eased : 1.02;
    // 줌 펀치: 컷 순간 살짝 확대됐다가 빠르게 제자리로
    if (seg.transition === "punch" && local < PUNCH_SECONDS) zoom *= 1 + 0.14 * (1 - local / PUNCH_SECONDS) ** 2;
    // 벨로시티: 빠르게 → 느리게 → 빠르게 (재생 속도를 프레임마다 조절)
    if (seg.velocity && alpha === 1) {
      const target = Math.min(2, Math.max(0.4, seg.rate * (1.55 - 1.1 * Math.sin(Math.PI * p))));
      if (Math.abs(video.playbackRate - target) > 0.04) video.playbackRate = target;
    }
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
    ctx.globalAlpha = alpha;
    if (video.readyState >= 2) {
      // 가운데가 아니라 관심 지점(사람·움직임)이 화면 가운데에 오도록 자릅니다.
      const focus = focusAt(tracks.get(seg.sourceId) ?? [], video.currentTime);
      const x = cropOffset(focus.x, w, W) + dx;
      const y = cropOffset(focus.y, h, H) + dy;
      ctx.drawImage(video, x, y, w, h);
      // 휩: 컷 직후 가로로 번지는 잔상(모션 블러)
      if (seg.transition === "whip" && local < WHIP_SECONDS) {
        const strength = 1 - local / WHIP_SECONDS;
        const dir = Math.round(seg.start * 10) % 2 ? 1 : -1;
        ctx.globalAlpha = 0.22 * strength;
        for (let k = 1; k <= 4; k++) ctx.drawImage(video, x + dir * k * 22 * strength, y, w, h);
      }
    }
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
      ctx.fillStyle = tealOrange;
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
    if (titleLines.length && now < titleEnd) {
      const alpha = Math.min(1, now / 0.6, (titleEnd - now) / 0.4);
      const size = titleSize;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = titleFont;
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 24;
      ctx.fillStyle = "#fff";
      const lines = titleLines;
      lines.forEach((line, i) => ctx.fillText(line, W / 2, H * 0.5 + (i - (lines.length - 1) / 2) * size * 1.1));
      if (options.subtitle) {
        ctx.font = `700 ${Math.round(size * 0.3)}px ${font}`;
        ctx.fillStyle = "#ffd2c6";
        ctx.fillText(options.subtitle, W / 2, H * 0.5 + ((lines.length + 1) / 2) * size * 1.1);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
    // 사용자가 넣은 텍스트
    for (const text of texts) {
      const alpha = textAlpha(text.overlay, now);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = text.font;
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = 18;
      ctx.fillStyle = "#fff";
      const anchor = H * textAnchorY(text.overlay.position);
      text.lines.forEach((line, i) => ctx.fillText(line, W / 2, anchor + (i - (text.lines.length - 1) / 2) * text.size * 1.15));
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
    // 출처 화면이 없으면 끝에서 검게 페이드아웃
    if (!showCredits && now > plan.duration - END_FADE_SECONDS) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, (now - (plan.duration - END_FADE_SECONDS)) / END_FADE_SECONDS)})`;
      ctx.fillRect(0, 0, W, H);
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
    const size = creditSize;
    ctx.fillStyle = "#f26a4b";
    ctx.font = `700 ${size * 1.3}px ${font}`;
    let y = H * 0.3;
    ctx.fillText("SOURCES", W / 2, y);
    y += size * 2.6;
    ctx.fillStyle = "#e9e7df";
    ctx.font = `500 ${size}px ${font}`;
    for (const lines of creditLines) {
      for (const line of lines) {
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
            // 크로스페이드로 넘어갈 때는 앞 컷을 잠깐 더 재생해 겹쳐 그립니다.
            if (current >= 0 && plan.segments[index].transition !== "fade") pool[current % POOL_SIZE].pause();
            previous = current;
            current = index;
            const video = pool[index % POOL_SIZE];
            void prepared[index]?.then(() => video.play().catch(() => undefined));
            prepare(current + LOOKAHEAD);
          }
          const seg = plan.segments[current];
          const fading = seg.transition === "fade" && previous >= 0 && now - seg.start < FADE_SECONDS;
          if (fading) {
            drawVideo(plan.segments[previous], pool[previous % POOL_SIZE], now);
            drawVideo(seg, pool[current % POOL_SIZE], now, Math.min(1, (now - seg.start) / FADE_SECONDS));
          } else {
            if (previous >= 0) {
              pool[previous % POOL_SIZE].pause();
              previous = -1;
            }
            drawVideo(seg, pool[current % POOL_SIZE], now);
          }
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
    pool.forEach(disposeVideo);
  });

  await stopped;
  await audio.close().catch(() => undefined);
  options.onProgress(1);
  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), mimeType };
}
