// 프레임 분석 결과에서 "볼 만한 순간"을 골라냅니다. 브라우저 API에 의존하지 않는 순수 함수입니다.

import type { EditStyle } from "./style";

export interface FrameSample {
  t: number;
  /** 이전 샘플과의 픽셀 차이 (0~1) */
  motion: number;
  /** 오디오 RMS (0~1), 소리가 없으면 0 */
  audio: number;
  /** 채도 × 대비 (0~1) */
  color: number;
  /** 평균 밝기 (0~1) */
  brightness: number;
  /** 장면 전환 여부 */
  cut: boolean;
  /** 관심 지점(움직임·사람) 위치 0~1 — 화면 비율에 맞춰 자를 때 따라갈 곳 */
  focusX?: number;
  focusY?: number;
  /** 사람이 화면을 차지하는 비율 0~1 */
  presence?: number;
}

export interface Highlight {
  sourceId: string;
  start: number;
  length: number;
  score: number;
  /** 이 영상이 편집에서 차지할 비중 (주제 가중치를 영상 수로 나눈 값, 기본 1) */
  weight?: number;
}

export function normalize(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  // 극단값에 휘둘리지 않도록 5~95 백분위로 정규화합니다.
  const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const hi = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  const range = hi - lo;
  if (range <= 1e-9) return values.map(() => 0);
  return values.map(v => Math.min(1, Math.max(0, (v - lo) / range)));
}

/**
 * 장면 전환 감지. 기본값은 원본 영상용(큰 변화만), 참고 에딧의 컷을 셀 때는 더 민감하게 씁니다.
 * @param threshold 최소 픽셀 차이  @param ratio 주변 평균보다 몇 배 커야 하는지
 */
export function detectCuts(motion: number[], threshold = 0.22, ratio = 3): boolean[] {
  return motion.map((value, i) => {
    const window = motion.slice(Math.max(0, i - 4), i).concat(motion.slice(i + 1, i + 5));
    const avg = window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0;
    return value > threshold && value > avg * ratio;
  });
}

/** 샘플마다 0~1 점수를 매깁니다. */
/**
 * 샘플마다 0~1 점수를 매깁니다.
 * @param presenceWeight 사람이 화면에 크게 나올수록 더할 가중치 (인물 주제에서 그 사람이 보이는 순간을 고르려고, 기본 0)
 */
export function scoreSamples(samples: FrameSample[], weights: EditStyle["weights"], presenceWeight = 0): number[] {
  if (!samples.length) return [];
  // 장면 전환 자체의 픽셀 차이는 움직임으로 치지 않습니다.
  const motion = normalize(samples.map(s => (s.cut ? 0 : s.motion)));
  const audio = normalize(samples.map(s => s.audio));
  const color = normalize(samples.map(s => s.color));
  const presence = presenceWeight ? normalize(samples.map(s => s.presence ?? 0)) : null;
  const total = weights.motion + weights.audio + weights.color + weights.stability + presenceWeight || 1;
  return samples.map((s, i) => {
    const stability = 1 - motion[i];
    let score = (weights.motion * motion[i] + weights.audio * audio[i] + weights.color * color[i] + weights.stability * stability + (presence ? presenceWeight * presence[i] : 0)) / total;
    // 검은 화면, 하얗게 날아간 화면, 정지된 자막 화면은 피합니다.
    if (s.brightness < 0.08 || s.brightness > 0.95) score *= 0.15;
    if (s.color < 0.02) score *= 0.5;
    return score;
  });
}

/**
 * 길이 `length`초의 구간 가운데 점수가 높은 구간을 겹치지 않게 고릅니다.
 * 구간 중간에 장면 전환이 끼어 있으면 감점합니다.
 */
export function pickHighlights(
  sourceId: string,
  samples: FrameSample[],
  scores: number[],
  length: number,
  count: number,
  duration: number
): Highlight[] {
  if (!samples.length || duration < length) return [];
  const margin = Math.min(duration * 0.03, 3);
  const windows: Highlight[] = [];
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i].t;
    const end = start + length;
    if (start < margin || end > duration - margin) continue;
    let sum = 0;
    let n = 0;
    let cutPenalty = 0;
    for (let j = i; j < samples.length && samples[j].t < end; j++) {
      sum += scores[j];
      n++;
      if (j > i && samples[j].cut) cutPenalty += 0.35;
    }
    // 장면 전환 직후에서 시작하면 컷이 깔끔합니다.
    const cleanStart = samples[i].cut || samples[i + 1]?.cut ? 0.05 : 0;
    if (n) windows.push({ sourceId, start, length, score: Math.max(0, sum / n - cutPenalty + cleanStart) });
  }
  windows.sort((a, b) => b.score - a.score);
  const chosen: Highlight[] = [];
  const gap = Math.max(length * 0.75, 1);
  for (const w of windows) {
    if (chosen.every(c => Math.abs(c.start - w.start) >= length + gap * 0.25)) chosen.push(w);
    if (chosen.length >= count) break;
  }
  return chosen;
}
