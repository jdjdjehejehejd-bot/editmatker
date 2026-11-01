// 프레임 분석 결과에서 "볼 만한 순간"을 골라냅니다. 브라우저 API에 의존하지 않는 순수 함수입니다.

import type { EditStyle, ScenePreference } from "./style";
import { SPORT_PROFILES, type SportKind } from "./sport";

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
  /** 카메라 이동을 뺀 실제 동작의 크기 (motion은 카메라가 움직여도 커짐) */
  action?: number;
  /** 바로 앞 샘플과 이어지지 않음(긴 영상에서 따로 촘촘히 본 구간의 첫 샘플) — 구간을 넘어 비교하거나 이어 붙이지 않음 */
  gap?: boolean;
}

/** 이보다 움직임이 적은 샘플은 멈춘 화면(정지 화면·자막 카드·슬라이드)으로 봅니다 */
export const STATIC_MOTION = 0.004;
/** 이보다 세부가 적으면 빈 화면(단색·심하게 흐림) */
export const FLAT_DETAIL = 0.008;
/** 실제 동작(카메라 이동을 뺀 움직임)이 이 정도면 "충분히 살아 있는" 영상으로 봅니다 */
export const LIVELY_ACTION = 0.02;

export interface VideoQuality {
  /** 0~1: 영상 전체가 얼마나 살아 있는지 (움직임·멈춘 비율·빈 화면 비율) */
  score: number;
  /** 거의 내내 멈춰 있는 영상(사진 모음·슬라이드쇼·배경화면 영상) */
  still: boolean;
}

/**
 * 영상 전체의 살아 있는 정도. 장면 점수는 영상 안에서 상대적으로 매기므로, 영상 전체가 지루해도(사진 모음, 말만 하는 영상)
 * 그 안의 "가장 나은 장면"이 다른 영상의 좋은 장면과 똑같이 쓰였습니다. 영상끼리 비교하려고 절대값으로 잽니다.
 */
export function assessVideo(samples: FrameSample[]): VideoQuality {
  const live = samples.filter((s, i) => i > 0 && !s.cut);
  if (live.length < 4) return { score: 1, still: false };
  const actions = live.map(s => s.action ?? s.motion).sort((a, b) => a - b);
  const median = actions[Math.floor(actions.length / 2)];
  const frozen = live.filter(s => s.motion < STATIC_MOTION).length / live.length;
  const flat = live.filter(s => s.detail !== undefined && s.detail < FLAT_DETAIL).length / live.length;
  const score = Math.min(1, median / LIVELY_ACTION) * 0.6 + (1 - frozen) * 0.3 + (1 - flat) * 0.1;
  return { score: Math.max(0, Math.min(1, score)), still: frozen > 0.6 || (median < STATIC_MOTION && frozen > 0.4) };
}

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
  /** 편집에서 이 순간(peak)에 살짝 줌·번쩍 강조를 넣을지 (격투기 공격, 슛 같은 스포츠의 결정적 순간) */
  accent?: boolean;
}

/**
 * 샘플마다 "임팩트"(0~1): 움직임이 직전보다 갑자기 커지거나 소리가 확 커지는 정도.
 * 평균 움직임이 큰 장면이 아니라 주먹이 꽂히는 순간처럼 확 튀는 순간을 찾으려고 씁니다.
 */
export function impactSamples(samples: FrameSample[]): number[] {
  const raw = samples.map((s, i) => {
    if (s.cut || s.gap || !i) return 0;
    let before = 0;
    let n = 0;
    // 따로 본 구간(gap)의 앞 샘플과는 비교하지 않습니다.
    let from = Math.max(0, i - 3);
    for (let j = i; j > from; j--) if (samples[j].gap) from = j;
    for (let j = from; j < i; j++) {
      if (samples[j].cut) continue;
      before += samples[j].action ?? samples[j].motion;
      n++;
    }
    const level = s.action ?? s.motion;
    const rise = Math.max(0, level - (n ? before / n : 0));
    // 펀치처럼 확 튀었다가 가라앉는 움직임만 크게 칩니다. 카메라가 앞으로 따라가거나(입장 장면) 기둥이 지나가는 것처럼
    // 큰 움직임이 계속되면 시작점만 튀어 보여서, 바로 뒤에도 그만큼 큰 움직임이 이어지면 낮춥니다.
    let after = 0;
    let m = 0;
    for (let j = i + 1; j < Math.min(samples.length, i + 3); j++) {
      if (samples[j].cut || samples[j].gap) break;
      after += samples[j].action ?? samples[j].motion;
      m++;
    }
    const fall = m ? Math.max(0, level - after / m) : rise;
    // 크기가 아니라 "주변보다 얼마나 튀었는지"로 잽니다: 화면 전체가 계속 움직이는 장면에서 조금 더 커진 것보다,
    // 멀리서 찍혀 작게 보이는 선수의 펀치(가만있다가 확 움직임)가 더 결정적인 순간입니다.
    // 그래서 크기 대신 "직전 움직임의 몇 배로 커졌는지"(최대 4배)를 씁니다. 화면 잡음 수준의 변화는 빼고요.
    const baseline = n ? before / n : level;
    const ratio = rise >= MIN_RISE ? Math.min(MAX_RATIO, rise / (baseline + LOCAL_FLOOR)) : 0;
    const motionJump = rise > 0 ? ratio * (0.35 + 0.65 * Math.min(1, fall / rise)) : 0;
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
/** 스포츠 영상에서 결정적 순간이 없는 구간에 곱하는 값 */
export const NO_IMPACT_FACTOR = 0.5;
/** 주변 움직임이 거의 없을 때 튄 정도를 잴 기준 (멈춘 화면 수준) */
const LOCAL_FLOOR = 0.005;
/** 이보다 작게 커진 것은 화면 잡음(압축·조명 깜빡임)으로 봄 */
const MIN_RISE = 0.004;
/** 직전보다 몇 배까지 커진 것을 구분할지 */
const MAX_RATIO = 4;
/** 함성이 결정타보다 이만큼(초) 늦게 터진다고 보고 다시 볼 곳을 앞당깁니다 */
const ROAR_LEAD = 1;
/** 따로 본 구간의 마지막 샘플 뒤로 이만큼까지는 본 것으로 칩니다(샘플 간격 정도) */
const REGION_SLACK = 0.45;

/** 따로 본 구간(gap으로 나뉨)마다 처음·마지막 샘플 시각 */
export function sampleRegions(samples: FrameSample[]): { from: number; to: number }[] {
  const regions: { from: number; to: number }[] = [];
  for (const sample of samples) {
    if (!regions.length || sample.gap) regions.push({ from: sample.t, to: sample.t });
    else regions[regions.length - 1].to = sample.t;
  }
  return regions;
}

/**
 * 긴 영상은 처음에 듬성듬성(몇 초 간격) 볼 수밖에 없어 펀치처럼 찰나인 순간을 못 잡습니다.
 * 듬성듬성 본 결과에서 볼 만해 보이는 곳(실제 동작·소리가 튀는 곳·사람이 크게 보이는 곳)을 골라,
 * 그 근처만 촘촘히 다시 봅니다. 고른 곳끼리 겹치지 않고, 처음·끝(중계 시작·끝 화면)은 피합니다.
 * @param audioPeak 샘플마다 그 근처(앞뒤 반 간격)에서 소리가 가장 크게 튄 정도와 시각 — 타격음·함성.
 *   소리가 크게 튄 곳이면 그 시각을 가운데로 다시 봅니다(듬성듬성 본 지점은 그 순간과 몇 초 떨어져 있을 수 있음).
 */
export function pickRegions(
  coarse: FrameSample[],
  duration: number,
  regionSeconds: number,
  count: number,
  audioPeak?: { value: number; at: number }[],
  /** 사람이 작게 보이는 넓은 장면을 우선(격투기) */
  wide = false
): { from: number; to: number }[] {
  if (!coarse.length || count <= 0) return [];
  // 드물게 튀는 곳을 찾는 것이라 백분위(normalize)가 아니라 최솟값~최댓값으로 맞춥니다.
  const byRange = (values: number[]) => {
    const lo = Math.min(...values);
    const range = Math.max(...values) - lo;
    return range > 1e-9 ? values.map(v => (v - lo) / range) : values.map(() => 0);
  };
  const action = byRange(coarse.map(s => (s.cut ? 0 : (s.action ?? s.motion))));
  const loud = byRange(audioPeak ? audioPeak.map(p => p.value) : coarse.map(s => s.audio));
  const presence = byRange(coarse.map(s => s.presence ?? 0));
  const margin = Math.min(duration * 0.03, 3);
  const ranked = coarse
    .map((s, i) => {
      // 듬성듬성 본 한 지점의 움직임은 우연에 가깝고, 소리는 구간 전체를 훑은 것이라 소리를 비슷하게 칩니다.
      let score = 0.4 * action[i] + 0.45 * loud[i] + (wide ? 0.15 * (1 - presence[i]) : 0.15 * presence[i]);
      if (wide) score *= 1 - 0.5 * presence[i];
      // 검은 화면·멈춘 화면·빈 화면은 고르지 않습니다.
      if (s.brightness < 0.08 || s.brightness > 0.95) score *= 0.15;
      // 한 지점만 보고 멈춘 화면이라 하기는 이르니, 소리가 크게 튄 곳이면 깎지 않습니다.
      if (s.motion < STATIC_MOTION && loud[i] < 0.5) score *= 0.4;
      if (s.detail !== undefined && s.detail < FLAT_DETAIL) score *= 0.3;
      // 함성은 결정타 뒤에 터지므로, 소리가 튄 곳이면 그보다 조금 앞을 가운데로 봅니다.
      const center = audioPeak && loud[i] >= 0.5 && loud[i] > action[i] ? audioPeak[i].at - ROAR_LEAD : s.t;
      return { t: center, score };
    })
    .filter(c => c.t >= margin && c.t <= duration - margin)
    .sort((a, b) => b.score - a.score);
  const half = regionSeconds / 2;
  const regions: { from: number; to: number }[] = [];
  const take = (c: { t: number }) => {
    const from = Math.max(0, Math.min(c.t - half, duration - regionSeconds));
    const to = Math.min(duration - 0.1, from + regionSeconds);
    if (regions.some(r => from < r.to && to > r.from)) return false;
    regions.push({ from, to });
    return true;
  };
  // 절반은 전체에서 가장 볼 만한 곳, 나머지는 영상을 고르게 나눈 칸마다 가장 나은 곳 — 한 장면(입장·경기 뒤)에 몰리지 않고
  // 경기 전체를 살펴보게.
  const best = Math.ceil(count / 2);
  for (const c of ranked) {
    if (regions.length >= best) break;
    take(c);
  }
  // 영상을 count칸으로 나누고, 이미 본 곳에서 가장 먼 칸부터 그 칸의 가장 나은 곳을 고릅니다.
  const open = Array.from({ length: count }, (_, k) => ({ lo: (duration * k) / count, hi: (duration * (k + 1)) / count })).filter(
    slice => !regions.some(r => r.from < slice.hi && r.to > slice.lo)
  );
  while (regions.length < count && open.length) {
    const distance = (slice: { lo: number; hi: number }) => Math.min(...regions.map(r => Math.abs((r.from + r.to) / 2 - (slice.lo + slice.hi) / 2)), Infinity);
    open.sort((a, b) => distance(b) - distance(a));
    const slice = open.shift()!;
    ranked.find(c => c.t >= slice.lo && c.t < slice.hi && take(c));
  }
  for (const c of ranked) {
    if (regions.length >= count) break;
    take(c);
  }
  return regions.sort((a, b) => a.from - b.from);
}

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
export function scoreSamples(
  samples: FrameSample[],
  baseWeights: EditStyle["weights"],
  basePresence = 0,
  scene?: ScenePreference,
  /** wide: 사람이 화면을 채우는 클로즈업을 낮춤(격투기 — 경기 전 얼굴·입장 장면 대신 경기장 전경) */
  options: { cameraMotion?: boolean; wide?: boolean } = {}
): number[] {
  if (!samples.length) return [];
  // 특징 문장이 말하는 장면(격렬한, 잔잔한, 함성, 얼굴, 화려한)일수록 높게 칩니다.
  const weights = { ...baseWeights };
  let presenceWeight = basePresence;
  if (scene?.intensity === "intense") {
    weights.motion *= 1.6;
    weights.stability *= 0.3;
  } else if (scene?.intensity === "calm") {
    weights.motion *= 0.5;
    weights.stability += 0.8;
  }
  if (scene?.loud) weights.audio *= 1.8;
  if (scene?.colorful) weights.color *= 1.6;
  if (scene?.people) presenceWeight += 0.6;
  if (options.wide) presenceWeight = 0;
  const closeUp = options.wide ? normalize(samples.map(s => s.presence ?? 0)) : null;
  const brightnessWeight = scene?.brightness ? 0.4 : 0;
  const light = brightnessWeight ? normalize(samples.map(s => s.brightness)) : null;
  // 장면 전환 자체의 픽셀 차이는 움직임으로 치지 않습니다.
  // 카메라 이동을 뺀 실제 동작(action)을 재 두었으면 그걸 씁니다 — 카메라만 따라가는 걷기·견제 장면이 높게 나오지 않게.
  // 레이싱처럼 속도감이 핵심인 영상은 카메라 이동까지 움직임으로 칩니다.
  const motion = normalize(samples.map(s => (s.cut ? 0 : options.cameraMotion ? s.motion : (s.action ?? s.motion))));
  const audio = normalize(samples.map(s => s.audio));
  const color = normalize(samples.map(s => s.color));
  const presence = presenceWeight ? normalize(samples.map(s => s.presence ?? 0)) : null;
  const total = weights.motion + weights.audio + weights.color + weights.stability + presenceWeight + brightnessWeight || 1;
  return samples.map((s, i) => {
    const stability = 1 - motion[i];
    const lightness = light ? (scene?.brightness === "dark" ? 1 - light[i] : light[i]) : 0;
    let score = (weights.motion * motion[i] + weights.audio * audio[i] + weights.color * color[i] + weights.stability * stability + (presence ? presenceWeight * presence[i] : 0) + brightnessWeight * lightness) / total;
    // 검은 화면, 하얗게 날아간 화면, 정지된 자막 화면은 피합니다.
    if (s.brightness < 0.08 || s.brightness > 0.95) score *= 0.15;
    if (s.color < 0.02) score *= 0.5;
    // 단색·뿌연 화면 (세부를 재지 않은 예전 분석 결과는 건너뜀)
    if (s.detail !== undefined && s.detail < FLAT_DETAIL) score *= 0.3;
    if (closeUp) score *= 1 - 0.6 * closeUp[i];
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
  duration: number,
  /**
   * preferImpact: 결정적 순간이 중요한 영상 — 그런 순간이 있는 영상이면, 없는 구간(걷기·세리머니·견제)은 크게 낮춤
   * sport: 종목별 핵심 순간 기준(격투기 연타, 구기 드리블·슛 뒤 함성, 레이싱 속도감)
   */
  options: { preferImpact?: boolean; sport?: SportKind | null } = {}
): Highlight[] {
  if (!samples.length || duration < length) return [];
  const margin = Math.min(duration * 0.03, 3);
  const impact = impactSamples(samples);
  const profile = options.sport ? SPORT_PROFILES[options.sport] : null;
  const impactMin = profile?.impactMin ?? IMPACT_MIN;
  const peakPosition = profile?.peakPosition ?? PEAK_POSITION;
  // 구기: 슛 뒤 함성(소리가 뒤로 갈수록 커짐), 드리블·질주(빠른 동작이 계속되는 비율)를 재려고 미리 맞춥니다.
  const loud = profile?.climaxBonus ? normalize(samples.map(s => s.audio)) : null;
  const pace = profile?.driveBonus ? samples.map(s => (profile.useCameraMotion ? s.motion : (s.action ?? s.motion))) : null;
  const fastLine = pace ? [...pace].sort((a, b) => a - b)[Math.floor(pace.length * 0.7)] ?? 0 : 0;
  const windows: Highlight[] = [];
  const refined = samples.some(sample => sample.gap);
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i].t;
    const end = start + length;
    if (start < margin || end > duration - margin) continue;
    let sum = 0;
    let n = 0;
    let cutPenalty = 0;
    let still = 0;
    let peakIndex = -1;
    let hits = 0;
    let fast = 0;
    let broken = false;
    for (let j = i; j < samples.length && samples[j].t < end; j++) {
      // 따로 본 구간의 경계를 넘는 구간은 실제로 이어진 장면이 아니라 쓰지 않습니다.
      if (j > i && samples[j].gap) {
        broken = true;
        break;
      }
      sum += scores[j];
      n++;
      if (impact[j] >= impactMin && (peakIndex < 0 || impact[j] > impact[peakIndex])) peakIndex = j;
      // 연타: 임팩트가 새로 시작되는 샘플 수
      if (impact[j] >= impactMin && (j === i || impact[j - 1] < impactMin)) hits++;
      if (pace && pace[j] >= fastLine && fastLine > 0) fast++;
      if (j > i && samples[j].cut) cutPenalty += 0.35;
      if (j > i && !samples[j].cut && samples[j].motion < STATIC_MOTION) still++;
    }
    // 장면 전환 직후에서 시작하면 컷이 깔끔합니다.
    const cleanStart = samples[i].cut || samples[i + 1]?.cut ? 0.05 : 0;
    // 거의 내내 멈춘 화면(정지 화면·자막 카드)은 에딧에 의미가 없으므로 크게 낮춥니다.
    const frozen = n > 2 && still / (n - 1) > 0.8 ? 0.35 : 1;
    // 확 튀는 순간이 있는 구간을 조금 더 높게 칩니다(펀치·슛·덩크 같은 결정적 장면).
    const impactBonus = peakIndex >= 0 ? 0.15 * impact[peakIndex] : 0;
    // 종목별: 격투기 연타, 구기 슛 뒤 함성·드리블, 레이싱 속도감
    let sportBonus = 0;
    if (profile && n > 2) {
      sportBonus += profile.comboBonus * Math.min(3, Math.max(0, hits - 1));
      if (loud) {
        const third = Math.max(1, Math.floor(n / 3));
        const head = loud.slice(i, i + third);
        const tail = loud.slice(i + n - third, i + n);
        const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
        sportBonus += profile.climaxBonus * Math.max(0, Math.min(1, mean(tail) - mean(head)));
      }
      if (pace) sportBonus += profile.driveBonus * (fast / n);
    }
    // 따로 본 구간의 끝을 넘어가는 구간(뒤쪽 장면을 실제로 보지 않음)도 쓰지 않습니다.
    if (broken || (refined && n && samples[i + n - 1].t < end - REGION_SLACK)) continue;
    if (n) {
      // 종목에 따라 장면 자체(움직임·색·소리)보다 결정적 순간의 세기를 더 봅니다.
      const weight = profile?.impactWeight ?? 0;
      const base = (1 - weight) * (sum / n) + weight * (peakIndex >= 0 ? impact[peakIndex] : 0);
      const window: Highlight = { sourceId, start, length, score: Math.max(0, (base - cutPenalty + cleanStart + impactBonus + sportBonus) * frozen) };
      if (peakIndex >= 0) {
        window.peak = samples[peakIndex].t;
        if (profile?.accent) window.accent = true;
      }
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
  // 촘촘히 본 구간들: 옮긴 구간이 그 구간 밖(보지 않은 곳)으로 나가지 않게 합니다.
  const regions = refined ? sampleRegions(samples) : [{ from: -Infinity, to: Infinity }];
  for (const w of windows) {
    if (w.peak === undefined) continue;
    const peak = w.peak;
    const region = regions.find(r => peak >= r.from && peak <= r.to) ?? regions[0];
    let start = Math.min(Math.max(margin, region.from, peak - peakPosition * length), duration - margin - length, region.to + REGION_SLACK - length);
    if (start < region.from) start = w.start;
    const lastCut = cutTimes.filter(t => t > start && t <= peak).pop();
    if (lastCut !== undefined) start = lastCut;
    if (average(start) >= average(w.start) * 0.9) w.start = start;
    // 옮기지 못했어도 임팩트가 구간 밖으로 밀려났으면 편집에서 쓰지 않게 지웁니다.
    if (w.peak < w.start || w.peak >= w.start + length) {
      delete w.peak;
      delete w.accent;
    }
  }
  if ((options.preferImpact || profile) && windows.some(w => w.peak !== undefined)) {
    const factor = profile?.noImpactFactor ?? NO_IMPACT_FACTOR;
    for (const w of windows) if (w.peak === undefined) w.score *= factor;
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
