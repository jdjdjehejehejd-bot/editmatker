// 참고 에딧에서 편집 스타일 배우기.
// 실제 에딧 영상(인터넷에서 찾거나 사용자가 올린 것)을 분석해 컷 리듬·템포·색감·자주 쓰는 효과를 뽑고,
// 그 값을 편집 스타일에 덮어씁니다. 참고 영상의 장면 자체는 결과물에 쓰지 않습니다.

import { detectCuts, type FrameSample } from "./highlights";
import type { Effect, EditStyle, Grade } from "./style";

/** 프레임 한 장의 색 통계 (0~1) */
export interface FrameStats {
  saturation: number;
  /** 빨강-파랑 평균 차이: 양수면 따뜻한 색, 음수면 차가운 색 */
  warmth: number;
  brightness: number;
  /** 위·아래 가장자리가 검은 띠(레터박스)인지 */
  letterbox: boolean;
}

export interface ReferenceAnalysis {
  title: string;
  duration: number;
  samples: FrameSample[];
  frames: FrameStats[];
  /** 참고 영상 음악의 BPM (소리가 없거나 추정 실패면 null) */
  bpm: number | null;
}

export interface StyleProfile {
  sources: string[];
  bpm: number | null;
  /** 평균 샷 길이(초) */
  averageShot: number;
  cuts: number;
  cutBeats: EditStyle["cutBeats"] | null;
  grade: Grade | null;
  addEffects: Effect[];
  removeEffects: Effect[];
}

/** RGBA 픽셀에서 색 통계를 계산합니다. */
export function statsFromPixels(data: Uint8ClampedArray | number[], width: number, height: number): FrameStats {
  let sat = 0;
  let warm = 0;
  let bright = 0;
  let edge = 0;
  let edgeCount = 0;
  const band = Math.max(1, Math.round(height * 0.08));
  for (let y = 0; y < height; y++) {
    const isEdge = y < band || y >= height - band;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sat += max ? (max - Math.min(r, g, b)) / max : 0;
      warm += r - b;
      bright += l;
      if (isEdge) {
        edge += l;
        edgeCount++;
      }
    }
  }
  const n = width * height;
  const brightness = bright / n;
  const edgeBrightness = edgeCount ? edge / edgeCount : brightness;
  return { saturation: sat / n, warmth: warm / n, brightness, letterbox: edgeBrightness < 0.04 && brightness > 0.12 };
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 장면 전환 시각으로부터 샷 길이 목록을 만듭니다. */
export function shotLengths(samples: FrameSample[], duration: number): { start: number; length: number }[] {
  // 에딧은 비슷한 색의 장면끼리도 자주 끊으므로 원본 영상보다 민감한 기준으로 컷을 다시 셉니다.
  const sensitive = detectCuts(samples.map(s => s.motion), 0.06, 2.2);
  const cuts = [0, ...samples.filter((s, i) => s.cut || sensitive[i]).map(s => s.t), duration];
  const shots: { start: number; length: number }[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const length = cuts[i] - cuts[i - 1];
    if (length >= 0.15) shots.push({ start: cuts[i - 1], length });
  }
  return shots;
}

/** 짧은 밝기 급등(흰 화면 번쩍임) 횟수 */
export function countFlashes(samples: FrameSample[]): number {
  let flashes = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    const jump = samples[i].brightness - samples[i - 1].brightness;
    if (jump > 0.3 && samples[i].brightness > 0.7 && samples[i + 1].brightness < samples[i].brightness - 0.15) flashes++;
  }
  return flashes;
}

function toPattern(lengths: number[], beat: number): number[] {
  return lengths.slice(0, 12).map(length => Math.min(8, Math.max(1, Math.round(length / beat))));
}

/**
 * 참고 에딧 여러 개를 합쳐 스타일 프로필을 만듭니다.
 * - 컷 리듬: 샷 길이를 박자 단위로 바꿔 인트로(앞 25%)·드롭·아웃트로(끝 12%) 패턴으로 나눔
 * - 템포: 참고 영상들의 음악 BPM 중앙값
 * - 색감: 채도·따뜻함 평균 (흑백·따뜻함·차가움·선명함)
 * - 효과: 플래시가 잦으면 플래시, 레터박스가 보이면 레터박스, 컷이 아주 빠르면 흔들림·펄스, 느리면 슬로모션
 */
export function buildProfile(references: ReferenceAnalysis[], fallbackBpm: number): StyleProfile | null {
  const usable = references.filter(r => r.duration >= 5 && r.samples.length >= 10);
  if (!usable.length) return null;
  const bpms = usable.map(r => r.bpm).filter((b): b is number => b !== null && b >= 60 && b <= 200);
  const bpm = bpms.length ? Math.round(median(bpms)) : null;
  const beat = 60 / (bpm ?? fallbackBpm);

  const intro: number[] = [];
  const drop: number[] = [];
  const outro: number[] = [];
  const allShots: number[] = [];
  let flashes = 0;
  for (const ref of usable) {
    const shots = shotLengths(ref.samples, ref.duration);
    for (const shot of shots) {
      allShots.push(shot.length);
      const position = shot.start / ref.duration;
      (position < 0.25 ? intro : position >= 0.88 ? outro : drop).push(shot.length);
    }
    flashes += countFlashes(ref.samples);
  }
  const cuts = allShots.length - usable.length;
  const confident = cuts >= 4;
  const cutBeats = confident
    ? {
        intro: toPattern(intro.length ? intro : allShots, beat),
        drop: toPattern(drop.length ? drop : allShots, beat),
        outro: toPattern(outro.length ? outro : allShots.slice(-2), beat),
      }
    : null;

  const frames = usable.flatMap(r => r.frames);
  let grade: Grade | null = null;
  if (frames.length) {
    const saturation = frames.reduce((s, f) => s + f.saturation, 0) / frames.length;
    const warmth = frames.reduce((s, f) => s + f.warmth, 0) / frames.length;
    // 따뜻한·차가운 보정은 보통 채도도 높으므로, 색 기울기를 먼저 보고 그다음 선명함을 봅니다.
    if (saturation < 0.06) grade = "mono";
    else if (warmth > 0.07) grade = "warm";
    else if (warmth < -0.05) grade = "cool";
    else if (saturation > 0.5) grade = "vivid";
  }

  const averageShot = allShots.length ? allShots.reduce((a, b) => a + b, 0) / allShots.length : 0;
  const medianBeats = median(allShots) / beat;
  const addEffects: Effect[] = [];
  const removeEffects: Effect[] = [];
  if (cuts > 0 && flashes / cuts >= 0.15) addEffects.push("flash");
  if (frames.length && frames.filter(f => f.letterbox).length / frames.length >= 0.5) addEffects.push("letterbox");
  if (confident && medianBeats <= 1.5) addEffects.push("shake", "pulse", "velocity");
  if (confident && medianBeats >= 4) {
    addEffects.push("slowmo");
    removeEffects.push("shake", "glitch");
  }
  return { sources: usable.map(r => r.title), bpm, averageShot, cuts, cutBeats, grade, addEffects, removeEffects };
}

/** 배운 프로필을 편집 스타일에 덮어씁니다. 사용자가 고른 무드·검색 힌트는 그대로 둡니다. */
export function applyProfile(style: EditStyle, profile: StyleProfile | null): EditStyle {
  if (!profile) return style;
  const effects = new Set(style.effects);
  for (const effect of profile.removeEffects) effects.delete(effect);
  for (const effect of profile.addEffects) effects.add(effect);
  return {
    ...style,
    bpm: profile.bpm ? Math.min(180, Math.max(70, profile.bpm)) : style.bpm,
    cutBeats: profile.cutBeats ?? style.cutBeats,
    grade: profile.grade ?? style.grade,
    effects,
    label: `${style.label} · 참고 에딧 스타일`,
  };
}

/** 화면에 보여 줄 한 줄 요약 */
export function describeProfile(profile: StyleProfile): string {
  const parts = [`참고 에딧 ${profile.sources.length}개`];
  if (profile.averageShot) parts.push(`평균 컷 ${profile.averageShot.toFixed(1)}초`);
  if (profile.bpm) parts.push(`${profile.bpm} BPM`);
  return parts.join(" · ");
}
