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
  /** 화면의 세부(이웃 픽셀 밝기 차 평균) — 단색·뿌연 화면은 0에 가까움 */
  detail?: number;
}

/** 이보다 움직임이 적은 샘플은 멈춘 화면(정지 화면·자막 카드·슬라이드)으로 봅니다 */
export const STATIC_MOTION = 0.004;
/** 이보다 세부가 적으면 빈 화면(단색·심하게 흐림) */
export const FLAT_DETAIL = 0.008;
/** 같은 영상에서 가장 좋은 구간 점수의 이 비율보다 낮은 구간은 쓰지 않습니다(장면이 모자라면 좋은 장면을 다시 씀) */
export const MIN_RELATIVE_SCORE = 0.45;

export interface Highlight {
  sourceId: string;
  start: number;
  length: number;
  score: number;
  /** 이 영상이 편집에서 차지할 비중 (주제 가중치를 영상 수로 나눈 값, 기본 1) */
  weight?: number;
  /** 구간에서 가장 강한 순간(펀치·슛·착지처럼 움직임과 소리가 확 튀는 때)의 원본 시각 — 편집에서 이 순간이 잘리지 않게 씀 */
  peak?: number;
}

/**
 * 샘플마다 "임팩트"(0~1): 움직임이 직전보다 갑자기 커지거나 소리가 확 커지는 정도.
 * 평균 움직임이 큰 장면이 아니라 주먹이 꽂히는 순간처럼 확 튀는 순간을 찾으려고 씁니다.
 */
export function impactSamples(samples: FrameSample[]): number[] {
  const raw = samples.map((s, i) => {
    if (s.cut || !i) return 0;
    let before = 0;
    let n = 0;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (samples[j].cut) continue;
      before += samples[j].motion;
      n++;
    }
    const motionJump = Math.max(0, s.motion - (n ? before / n : 0));
    const audioJump = Math.max(0, s.audio - samples[i - 1].audio);
    return { motionJump, audioJump };
  });
  // 드물게 확 튀는 값이 핵심이라 백분위가 아니라 최댓값 기준으로 맞춥니다(normalize는 튀는 값을 잘라 버림).
  const byMax = (values: number[]) => {
    const max = Math.max(0, ...values);
    return max > 1e-9 ? values.map(v => v / max) : values.map(() => 0);
  };
  const motion = byMax(raw.map(r => (r ? r.motionJump : 0)));
  const audio = byMax(raw.map(r => (r ? r.audioJump : 0)));
  return samples.map((_, i) => Math.min(1, 0.65 * motion[i] + 0.35 * audio[i]));
}

/** 임팩트가 구간 안 이 위치(앞에서부터 비율)쯤 오게 구간을 다시 잡습니다 — 준비 동작과 맞은 뒤 반응까지 보이게 */
export const PEAK_POSITION = 0.55;
/** 이 정도 이상 튀어야 "임팩트"로 봅니다 */
const IMPACT_MIN = 0.35;

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
    // 단색·뿌연 화면 (세부를 재지 않은 예전 분석 결과는 건너뜀)
    if (s.detail !== undefined && s.detail < FLAT_DETAIL) score *= 0.3;
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
  const impact = impactSamples(samples);
  const windows: Highlight[] = [];
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i].t;
    const end = start + length;
    if (start < margin || end > duration - margin) continue;
    let sum = 0;
    let n = 0;
    let cutPenalty = 0;
    let still = 0;
    let peakIndex = -1;
    for (let j = i; j < samples.length && samples[j].t < end; j++) {
      sum += scores[j];
      n++;
      if (impact[j] >= IMPACT_MIN && (peakIndex < 0 || impact[j] > impact[peakIndex])) peakIndex = j;
      if (j > i && samples[j].cut) cutPenalty += 0.35;
      if (j > i && !samples[j].cut && samples[j].motion < STATIC_MOTION) still++;
    }
    // 장면 전환 직후에서 시작하면 컷이 깔끔합니다.
    const cleanStart = samples[i].cut || samples[i + 1]?.cut ? 0.05 : 0;
    // 거의 내내 멈춘 화면(정지 화면·자막 카드)은 에딧에 의미가 없으므로 크게 낮춥니다.
    const frozen = n > 2 && still / (n - 1) > 0.8 ? 0.35 : 1;
    // 확 튀는 순간이 있는 구간을 조금 더 높게 칩니다(펀치·슛·덩크 같은 결정적 장면).
    const impactBonus = peakIndex >= 0 ? 0.15 * impact[peakIndex] : 0;
    if (n) {
      const window: Highlight = { sourceId, start, length, score: Math.max(0, (sum / n - cutPenalty + cleanStart + impactBonus) * frozen) };
      if (peakIndex >= 0) window.peak = samples[peakIndex].t;
      windows.push(window);
    }
  }
  // 임팩트가 구간 끝에 걸리면 맞는 순간 직전에 컷이 넘어가므로, 임팩트가 구간 가운데쯤 오게 구간을 옮깁니다.
  // 단, 옮긴 구간에 다른 장면(장면 전환 앞)이 섞이지 않게 임팩트 직전의 장면 전환보다 앞으로는 가지 않습니다.
  // 또 옮긴 구간이 원래보다 눈에 띄게 심심해지면(예: 계속 이어지는 동작의 시작점 — 앞이 그냥 빈 장면) 옮기지 않습니다.
  const cutTimes = samples.filter(sample => sample.cut).map(sample => sample.t);
  const average = (from: number) => {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < samples.length; j++) {
      if (samples[j].t < from) continue;
      if (samples[j].t >= from + length) break;
      sum += scores[j];
      n++;
    }
    return n ? sum / n : 0;
  };
  for (const w of windows) {
    if (w.peak === undefined) continue;
    const peak = w.peak;
    let start = Math.min(Math.max(margin, peak - PEAK_POSITION * length), duration - margin - length);
    const lastCut = cutTimes.filter(t => t > start && t <= peak).pop();
    if (lastCut !== undefined) start = lastCut;
    if (average(start) >= average(w.start) * 0.9) w.start = start;
    // 옮기지 못했어도 임팩트가 구간 밖으로 밀려났으면 편집에서 쓰지 않게 지웁니다.
    if (w.peak < w.start || w.peak >= w.start + length) delete w.peak;
  }
  windows.sort((a, b) => b.score - a.score);
  // 의미 없는 구간을 채워 넣지 않도록, 가장 좋은 구간보다 많이 떨어지는 구간은 고르지 않습니다.
  const floor = (windows[0]?.score ?? 0) * MIN_RELATIVE_SCORE;
  const chosen: Highlight[] = [];
  const gap = Math.max(length * 0.75, 1);
  for (const w of windows) {
    if (chosen.length && w.score < floor) break;
    if (chosen.every(c => Math.abs(c.start - w.start) >= length + gap * 0.25)) chosen.push(w);
    if (chosen.length >= count) break;
  }
  return chosen;
}
