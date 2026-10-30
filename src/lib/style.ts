// 사용자가 자유롭게 적은 "특징" 문장을 편집 스타일 값으로 바꿉니다.

import { isNsfwRequested } from "./moderation";

export type Mood = "hype" | "cinematic" | "emotional" | "retro";
export type Grade = "natural" | "warm" | "cool" | "mono" | "vivid" | "teal-orange";
export type Effect = "flash" | "shake" | "zoom" | "glitch" | "slowmo" | "grain" | "letterbox" | "pulse" | "velocity";

export interface EditStyle {
  mood: Mood;
  bpm: number;
  grade: Grade;
  effects: Set<Effect>;
  /** 구간별 컷 길이(박자 단위). 인트로 → 드롭 → 아웃트로 */
  cutBeats: { intro: number[]; drop: number[]; outro: number[] };
  /** 하이라이트 점수 가중치 */
  weights: { motion: number; audio: number; color: number; stability: number };
  /** 소스 검색에 덧붙일 영어 키워드 */
  searchHints: string[];
  label: string;
  /** 특징에 "120bpm"처럼 템포를 직접 적었는지 */
  bpmExplicit?: boolean;
  /** 컷 전환을 하나로 고정 (없으면 무드에 맞게 자동) */
  transition?: TransitionStyle;
}

export type TransitionStyle = "cut" | "fade" | "whip" | "punch";
export type Pace = "slow" | "normal" | "fast";

/**
 * 편집 스타일 직접 설정. 비어 있는 항목은 특징 문장(또는 참고 에딧)에서 자동으로 정해집니다.
 * 우선순위: 직접 설정 > 참고 에딧에서 배운 값 > 특징 문장에서 읽은 값
 */
export interface StyleOverrides {
  mood?: Mood;
  bpm?: number;
  grade?: Grade;
  /** 효과별 켜기/끄기 (없는 효과는 자동) */
  effects?: Partial<Record<Effect, boolean>>;
  /** 컷 속도: 빠르게는 컷 길이를 절반으로, 느리게는 두 배로 */
  pace?: Pace;
  transition?: TransitionStyle;
}

export const MOOD_LABEL: Record<Mood, string> = { hype: "하이프", cinematic: "시네마틱", emotional: "감성", retro: "레트로" };
export const PACE_LABEL: Record<Pace, string> = { slow: "느리게", normal: "보통", fast: "빠르게" };
export const TRANSITION_LABEL: Record<TransitionStyle, string> = { cut: "바로 컷", fade: "크로스페이드", whip: "휩", punch: "줌 펀치" };

function scalePattern(pattern: number[], factor: number) {
  return pattern.map(beats => Math.min(8, Math.max(1, Math.round(beats * factor))));
}

/** 분위기 말고 나머지 직접 설정을 덮어씁니다(분위기는 parseStyle의 options.mood로 넘깁니다). */
export function applyOverrides(style: EditStyle, overrides: StyleOverrides | undefined): EditStyle {
  if (!overrides) return style;
  const effects = new Set(style.effects);
  for (const [effect, on] of Object.entries(overrides.effects ?? {}) as [Effect, boolean][]) {
    if (on) effects.add(effect);
    else effects.delete(effect);
  }
  const factor = overrides.pace === "fast" ? 0.5 : overrides.pace === "slow" ? 2 : 1;
  return {
    ...style,
    bpm: overrides.bpm ? clamp(Math.round(overrides.bpm), 60, 180) : style.bpm,
    bpmExplicit: style.bpmExplicit || Boolean(overrides.bpm),
    grade: overrides.grade ?? style.grade,
    effects,
    cutBeats:
      factor === 1
        ? style.cutBeats
        : { intro: scalePattern(style.cutBeats.intro, factor), drop: scalePattern(style.cutBeats.drop, factor), outro: scalePattern(style.cutBeats.outro, factor) },
    transition: overrides.transition ?? style.transition,
  };
}

/** 저장된 값(프리셋)에서 쓸 수 있는 설정만 골라냅니다. */
const has = (table: object, key: unknown) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);

export function sanitizeOverrides(value: any): StyleOverrides {
  if (!value || typeof value !== "object") return {};
  const out: StyleOverrides = {};
  if (has(MOOD_PRESETS, value.mood)) out.mood = value.mood;
  if (Number.isFinite(value.bpm) && value.bpm >= 60 && value.bpm <= 180) out.bpm = Math.round(value.bpm);
  if (has(GRADE_LABEL, value.grade)) out.grade = value.grade;
  if (has(PACE_LABEL, value.pace)) out.pace = value.pace;
  if (has(TRANSITION_LABEL, value.transition)) out.transition = value.transition;
  if (value.effects && typeof value.effects === "object") {
    const effects: Partial<Record<Effect, boolean>> = {};
    for (const [key, on] of Object.entries(value.effects)) if (has(EFFECT_LABEL, key) && typeof on === "boolean") effects[key as Effect] = on;
    if (Object.keys(effects).length) out.effects = effects;
  }
  return out;
}

/** 배경음악 스타일 — auto면 편집 분위기를 따라갑니다 */
export type MusicStyle = "auto" | Mood;

export const MUSIC_STYLE_LABEL: Record<MusicStyle, string> = {
  auto: "자동 (분위기 따라)",
  hype: "하이프 · 트랩",
  cinematic: "시네마틱 · 웅장",
  emotional: "감성 · 피아노",
  retro: "레트로 · 신스웨이브",
};

/** 음악 스타일별 기본 템포 */
export function defaultBpm(mood: Mood): number {
  return MOOD_PRESETS[mood].bpm;
}

const MOOD_KEYWORDS: Record<Mood, RegExp> = {
  hype: /빠른|빠르게|에너지|신나|강렬|하이프|격렬|폭발|힙합|펑크|파워|박진감|열정|미친|hype|fast|energ|phonk|trap|intense|aggressive/i,
  cinematic: /시네마|영화|웅장|장엄|에픽|서사|비장|전설|트레일러|cinema|epic|movie|trailer|legend/i,
  emotional: /잔잔|감성|감동|느린|차분|몽환|그리움|슬픈|추억|로파이|여운|따뜻한 감|calm|chill|lofi|lo-fi|sad|emotional|soft|dreamy|slow/i,
  retro: /레트로|빈티지|옛날|복고|vhs|80년대|90년대|필름|아날로그|retro|vintage|synthwave|old/i,
};

const MOOD_PRESETS: Record<Mood, Omit<EditStyle, "mood" | "grade" | "effects" | "searchHints"> & { grade: Grade; effects: Effect[] }> = {
  hype: {
    bpm: 140,
    grade: "vivid",
    effects: ["flash", "shake", "pulse", "zoom", "velocity"],
    cutBeats: { intro: [4, 4], drop: [2, 1, 1, 2, 2, 1, 1, 4], outro: [4] },
    weights: { motion: 1, audio: 0.7, color: 0.35, stability: 0 },
    label: "하이프 · 빠른 비트 컷",
  },
  cinematic: {
    bpm: 90,
    grade: "teal-orange",
    effects: ["letterbox", "zoom", "slowmo", "flash"],
    cutBeats: { intro: [8, 4], drop: [2, 2, 4, 2, 2, 4], outro: [8] },
    weights: { motion: 0.6, audio: 0.5, color: 0.8, stability: 0.3 },
    label: "시네마틱 · 웅장한 전개",
  },
  emotional: {
    bpm: 80,
    grade: "warm",
    effects: ["zoom", "slowmo", "grain"],
    cutBeats: { intro: [8], drop: [4, 4, 2, 2, 4], outro: [8] },
    weights: { motion: 0.25, audio: 0.3, color: 1, stability: 0.8 },
    label: "감성 · 잔잔한 여운",
  },
  retro: {
    bpm: 105,
    grade: "warm",
    effects: ["grain", "glitch", "flash", "zoom"],
    cutBeats: { intro: [4, 4], drop: [2, 2, 1, 1, 2, 4], outro: [4] },
    weights: { motion: 0.7, audio: 0.5, color: 0.6, stability: 0.2 },
    label: "레트로 · 신스웨이브",
  },
};

const GRADE_KEYWORDS: [Grade, RegExp][] = [
  ["mono", /흑백|모노|black ?and ?white|monochrome|b&w|noir/i],
  ["teal-orange", /틸|teal|블록버스터|blockbuster/i],
  ["cool", /차가|차갑|시원|푸른|블루|파란|새벽|겨울|cold|cool|blue|icy/i],
  ["warm", /따뜻|노을|황금|골든|여름|warm|golden|sunset/i],
  ["vivid", /네온|화려|선명|쨍|비비드|neon|vivid|colorful|saturated/i],
  ["natural", /자연스러|내추럴|원본 색|natural/i],
];

const EFFECT_KEYWORDS: [Effect, RegExp][] = [
  ["glitch", /글리치|노이즈|깨지|glitch/i],
  ["shake", /흔들|쉐이크|셰이크|진동|shake/i],
  ["flash", /플래시|번쩍|섬광|flash/i],
  ["slowmo", /슬로우|슬로모|느리게|slow ?-?mo/i],
  ["zoom", /줌|확대|zoom/i],
  ["grain", /그레인|필름|grain/i],
  ["letterbox", /레터박스|시네마스코프|letterbox/i],
  ["pulse", /펄스|비트에 맞|박자|pulse|beat/i],
  ["velocity", /벨로시티|속도 ?변화|스피드 ?램프|velocity|speed ?ramp/i],
];

// 한국어 특징 단어를 Commons 검색에 쓸 수 있는 영어 키워드로 옮깁니다.
const HINT_DICTIONARY: [RegExp, string][] = [
  [/골|득점|슈팅/, "goal"],
  [/경기|매치/, "match"],
  [/축구/, "football"],
  [/농구/, "basketball"],
  [/야구/, "baseball"],
  [/무대|공연|콘서트|라이브/, "concert"],
  [/춤|댄스|안무/, "dance"],
  [/노래|보컬/, "singing"],
  [/인터뷰/, "interview"],
  [/연설|스피치/, "speech"],
  [/발사|로켓/, "launch"],
  [/우주/, "space"],
  [/자동차|레이싱|레이스/, "racing"],
  [/비행|전투기|에어쇼/, "flight"],
  [/자연|풍경/, "nature"],
  [/바다|파도/, "ocean"],
  [/동물/, "animal"],
  [/도시|야경/, "city"],
  [/훈련|연습/, "training"],
];

export function parseStyle(features: string, options: { mood?: Mood } = {}): EditStyle {
  const text = features.trim();
  const scores = (Object.keys(MOOD_KEYWORDS) as Mood[]).map(mood => ({
    mood,
    hits: (text.match(new RegExp(MOOD_KEYWORDS[mood].source, "gi")) ?? []).length,
  }));
  const best = scores.reduce((a, b) => (b.hits > a.hits ? b : a));
  // 분위기를 직접 골랐으면 그 분위기의 기본값(템포·컷 리듬·효과)을 씁니다.
  const mood: Mood = options.mood ?? (best.hits > 0 ? best.mood : "hype");
  const preset = MOOD_PRESETS[mood];

  const grade = GRADE_KEYWORDS.find(([, re]) => re.test(text))?.[0] ?? preset.grade;
  const effects = new Set<Effect>(preset.effects);
  for (const [effect, re] of EFFECT_KEYWORDS) if (re.test(text)) effects.add(effect);
  if (/효과 ?없|깔끔|미니멀|clean|minimal/i.test(text)) {
    effects.delete("glitch");
    effects.delete("shake");
    effects.delete("grain");
  }

  const bpmMatch = /(\d{2,3})\s*bpm/i.exec(text);
  const bpm = bpmMatch ? clamp(Number(bpmMatch[1]), 60, 180) : preset.bpm;

  const searchHints = [...new Set(HINT_DICTIONARY.filter(([re]) => re.test(text)).map(([, hint]) => hint))];
  for (const word of text.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? []) {
    // 검열 표시(NSFW 등)는 분위기 키워드가 아니므로 검색어에 넣지 않습니다.
    if (isNsfwRequested(word)) continue;
    if (!Object.values(MOOD_KEYWORDS).some(re => re.test(word)) && searchHints.length < 4) searchHints.push(word.toLowerCase());
  }

  return {
    mood,
    bpm,
    bpmExplicit: Boolean(bpmMatch),
    grade,
    effects,
    cutBeats: preset.cutBeats,
    weights: preset.weights,
    searchHints: searchHints.slice(0, 4),
    label: preset.label,
  };
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export const GRADE_LABEL: Record<Grade, string> = {
  natural: "자연스러운 색",
  warm: "따뜻한 색감",
  cool: "차가운 색감",
  mono: "흑백",
  vivid: "선명한 네온",
  "teal-orange": "틸 & 오렌지",
};

export const EFFECT_LABEL: Record<Effect, string> = {
  flash: "플래시 컷",
  shake: "비트 흔들림",
  zoom: "줌 무빙",
  glitch: "글리치",
  slowmo: "슬로모션",
  grain: "필름 그레인",
  letterbox: "레터박스",
  pulse: "비트 펄스",
  velocity: "벨로시티",
};
