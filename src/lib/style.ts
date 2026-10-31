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
  /** 컷 속도 (특징 문장에서 읽었으면 그 값, 없으면 보통) */
  pace?: Pace;
  /** 특징 문장에서 알아들은 말 (화면에 "이렇게 읽었어요"로 보여 줌) */
  matched?: string[];
  /** 특징 문장이 말하는 "어떤 장면"을 고를지 (밝기, 동작 세기, 함성, 사람 얼굴, 화려함, 찍힌 대상) */
  scene?: ScenePreference;
  /** 화면 느낌 보정 (밝기·대비·채도·빛 번짐·가장자리 어둡게). 없으면 색감(grade) 그대로 */
  look?: Look;
  /** 흐름: 드롭(본격적으로 터지는 지점)의 위치(0~1)와 아웃트로 길이(박자) */
  structure?: { dropRatio?: number; outroBeats?: number };
}

export interface Look {
  /** 1 = 그대로. 0.85 어둡게, 1.08 밝게 */
  exposure: number;
  contrast: number;
  saturation: number;
  /** 0~1 빛 번짐(몽환적) */
  glow: number;
  /** 가장자리 어둡게 세기 (1 = 기본) */
  vignette: number;
}

export const NEUTRAL_LOOK: Look = { exposure: 1, contrast: 1, saturation: 1, glow: 0, vignette: 1 };

/** 특징 문장의 "느낌" 낱말 → 화면 보정 */
const LOOK_RULES: { re: RegExp; apply: (look: Look) => void }[] = [
  { re: /밝고|밝은 ?(?:느낌|분위기|화면)|화사|청량|산뜻|상큼|햇살 ?같|bright ?(?:mood|look)|fresh/i, apply: l => ((l.exposure = 1.08), (l.vignette = Math.min(l.vignette, 0.6))) },
  { re: /어둡고|어두운 ?(?:느낌|분위기|화면)|음울|암울|무거운|다크한|느와르|우울|gloomy|moody|noir|dark ?(?:mood|look)/i, apply: l => ((l.exposure = 0.86), (l.vignette = Math.max(l.vignette, 1.5))) },
  { re: /강렬|쨍|선명하게|하드한|대비 ?강|punchy|contrasty/i, apply: l => (l.contrast = 1.15) },
  { re: /부드럽|뽀얀|뿌연|파스텔|은은|soft ?(?:look|light)|pastel/i, apply: l => ((l.contrast = 0.9), (l.glow = Math.max(l.glow, 0.4))) },
  { re: /화려|비비드|알록달록|채도 ?높|vibrant|vivid/i, apply: l => (l.saturation = 1.2) },
  { re: /물 ?빠진|바랜|빛바랜|차분한 ?색|채도 ?낮|무채색|muted|faded|washed/i, apply: l => (l.saturation = 0.75) },
  { re: /몽환|꿈 ?같|꿈결|환상|블룸|빛 ?번짐|글로우|dreamy|ethereal|glow|bloom/i, apply: l => (l.glow = 1) },
  { re: /긴장|미스터리|공포|스릴|섬뜩|tense|mystery|horror|thriller/i, apply: l => (l.vignette = Math.max(l.vignette, 1.6)) },
];

/** 흐름 낱말: 드롭 위치와 아웃트로 */
const STRUCTURE_RULES: { re: RegExp; apply: (s: { dropRatio?: number; outroBeats?: number }) => void }[] = [
  { re: /점점|서서히|빌드 ?업|고조|차근차근|build ?-?up|gradual/i, apply: s => (s.dropRatio = 0.4) },
  { re: /처음부터|시작부터|초반부터|바로 ?터지|오프닝부터|from the start|right away/i, apply: s => (s.dropRatio = 0.08) },
  { re: /여운|마무리 ?(?:는 ?)?잔잔|끝(?:은|에는)? ?잔잔|긴 ?아웃트로|천천히 ?끝|long ?outro|fade ?out ending/i, apply: s => (s.outroBeats = 8) },
];

export interface ScenePreference {
  brightness?: "bright" | "dark";
  intensity?: "intense" | "calm";
  /** 함성·환호처럼 소리가 큰 장면 */
  loud?: boolean;
  /** 얼굴·표정·클로즈업처럼 사람이 크게 보이는 장면 */
  people?: boolean;
  /** 화려하고 색이 선명한 장면 */
  colorful?: boolean;
  /** 찍힌 대상(이미지 분류 묶음의 term, 예: "ocean", "car racing") */
  subjects?: string[];
}

/** 특징 문장의 장면 낱말 → 장면 선호 */
const SCENE_RULES: { re: RegExp; apply: (p: ScenePreference) => void }[] = [
  { re: /밝은|밝게|화사|햇살|햇빛|낮 ?장면|대낮|bright|sunny|daylight/i, apply: p => (p.brightness = "bright") },
  { re: /어두운|어둡게|밤 ?장면|야간|야경|다크|그림자|dark|night/i, apply: p => (p.brightness = "dark") },
  { re: /격렬|격한|폭발|질주|난타|몸싸움|공격|액션|역동|타격|intense|action|explosive|fight/i, apply: p => (p.intensity = "intense") },
  { re: /잔잔한 ?장면|고요|평온|정적인|멈춘 ?듯|여유로운 ?장면|calm scenes?|still|peaceful/i, apply: p => (p.intensity = "calm") },
  { re: /함성|환호|관중|열광|떼창|응원|박수|crowd|cheer|roar/i, apply: p => (p.loud = true) },
  { re: /얼굴|표정|클로즈 ?업|인물 ?위주|사람 ?위주|눈빛|face|close ?-?up|portrait/i, apply: p => (p.people = true) },
  { re: /화려|알록달록|컬러풀|색감 ?좋|쨍한|colorful|vibrant/i, apply: p => (p.colorful = true) },
];

/** 한 글자 우리말 낱말(산, 개, 새, 배)이 다른 낱말 속(산책, 생산, 개인)에 든 경우를 빼고 찾는 정규식 조각 */
const koWord = (word: string) => `(?:^|[^가-힣0-9])${word}(?=$|[^가-힣]|[이을를에과와의도])`;

/** 찍힌 대상 낱말 → 이미지 분류 묶음(vision.ts CATEGORIES의 term) */
const SUBJECT_WORDS: [RegExp, string][] = [
  [/바다|해변|파도|해안|beach|ocean|\bsea\b|\bwaves?\b/i, "ocean"],
  [new RegExp(`${koWord("산")}|등산|설산|화산|mountain|hiking`, "i"), "mountain"],
  [/호수|lake/i, "lake"],
  [/도시|야경|빌딩|도심|city|street/i, "city"],
  [/자동차|레이싱|드리프트|\bcars?\b|racing|drift/i, "car racing"],
  [/오토바이|바이크|motorcycle|motorbike/i, "motorcycle"],
  [/비행기|전투기|에어쇼|airplane|jet/i, "airplane"],
  [/로켓|발사|우주|rocket|launch|space/i, "rocket launch"],
  [/무대|공연|콘서트|라이브|드럼|stage|concert/i, "concert"],
  [new RegExp(`강아지|${koWord("개")}|\\bdogs?\\b|puppy`, "i"), "dog"],
  [/고양이|\bcats?\b|kitten/i, "cat"],
  [new RegExp(`${koWord("새")}|\\bbirds?\\b`, "i"), "bird"],
  [/기차|\btrains?\b/i, "train"],
  [new RegExp(`${koWord("배")}|요트|보트|\\bships?\\b|\\bboats?\\b|yacht`, "i"), "ship"],
  [/음식|요리|먹방|food|cooking/i, "food"],
  [/스키|스노보드|snowboard|\bski(?:ing)?\b/i, "skiing"],
];

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

const PACE_FACTOR: Record<Pace, number> = { fast: 0.5, normal: 1, slow: 2 };

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
  // 특징 문장에서 이미 빠르게/느리게를 읽었으면 그 기준에서 고른 속도로 바꿉니다(직접 고른 속도가 그대로 나오게).
  const factor = overrides.pace ? PACE_FACTOR[overrides.pace] / PACE_FACTOR[style.pace ?? "normal"] : 1;
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
    pace: overrides.pace ?? style.pace,
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
  hype: /빠른|빠르게|에너지|신나|신난|강렬|하이프|격렬|폭발|힙합|펑크|파워|박진감|열정|미친|멋있|멋지|간지|쩌는|짜릿|화끈|역동|다이나믹|타격감|임팩트|하드|헤비|광란|분노|전투|싸움|파이팅|승리|스피디|드리프트|텐션|흥분|hype|fast|energ|phonk|trap|intense|aggressive|hard|dynamic|hyper|insane|crazy|edm|dubstep|drill|banger/i,
  cinematic: /시네마|영화|웅장|장엄|에픽|서사|비장|전설|트레일러|압도|긴장|긴박|소름|위엄|영웅|장대|드라마틱|오케스트라|명장면|대서사|cinema|epic|movie|trailer|legend|dramatic|orchestral|heroic|tense|majestic|grand/i,
  emotional: /잔잔|감성|감동|느린|차분|몽환|그리움|그리운|슬픈|추억|로파이|여운|따뜻한 감|부드럽|아련|애틋|힐링|평화|여유|고요|낭만|사랑|청춘|눈물|감미|피아노|어쿠스틱|calm|chill|lofi|lo-fi|sad|emotional|soft|dreamy|slow|piano|acoustic|healing|peaceful|romantic|nostalgic|gentle|mellow/i,
  retro: /레트로|빈티지|옛날|복고|vhs|80년대|90년대|필름|아날로그|8비트|픽셀|오락실|시티팝|디스코|캠코더|y2k|retro|vintage|synthwave|old|city ?pop|disco|camcorder|8-?bit/i,
};

/** 컷 속도: "빠른 컷", "천천히" 같은 말 */
const PACE_KEYWORDS: [Pace, RegExp][] = [
  ["fast", /빠른 ?컷|빠르게 ?(?:편집|자르|넘기|컷)|컷 ?빠르|속도감|정신없|쉴 ?틈|휙휙|숨 ?가쁘|fast ?cuts?|quick ?cuts?|rapid/i],
  ["slow", /천천히|느린 ?컷|느리게 ?(?:편집|넘기|컷)|길게|여유롭|롱테이크|롱 ?컷|slow ?cuts?|long ?takes?/i],
];

/** 전환: "페이드", "휩" 같은 말 */
const TRANSITION_KEYWORDS: [TransitionStyle, RegExp][] = [
  ["fade", /페이드|디졸브|부드러운 ?전환|자연스러운 ?전환|cross ?fade|fade|dissolve/i],
  ["whip", /휩|스와이프|휙 ?넘|whip|swipe/i],
  ["punch", /줌 ?펀치|펀치 ?줌|punch/i],
  ["cut", /하드 ?컷|바로 ?컷|점프 ?컷|hard ?cut|jump ?cut/i],
];

/** "슬로모션 없이", "흔들림 빼고", "no glitch" 처럼 효과를 빼 달라는 말인지 */
function negated(text: string, re: RegExp): boolean {
  const word = `(?:${re.source})`;
  return new RegExp(`${word}[가-힣]{0,3}\\s*(?:없이|빼고|빼줘|말고|제외|금지|싫|x\\b|안 ?(?:넣|쓰|써))|(?:no|without|without any)\\s+${word}`, "i").test(text);
}

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

  const matched = new Set<string>();
  const note = (re: RegExp) => {
    const hit = re.exec(text)?.[0];
    if (hit) matched.add(hit.trim());
    return Boolean(hit);
  };
  if (!options.mood && best.hits > 0) note(MOOD_KEYWORDS[mood]);
  const grade = GRADE_KEYWORDS.find(([, re]) => note(re))?.[0] ?? preset.grade;
  const effects = new Set<Effect>(preset.effects);
  for (const [effect, re] of EFFECT_KEYWORDS) {
    const hit = re.exec(text)?.[0]?.trim();
    if (!hit) continue;
    // "슬로모션 없이"처럼 빼 달라고 했으면 기본 효과에서도 뺍니다.
    if (negated(text, re)) {
      effects.delete(effect);
      matched.add(`${EFFECT_LABEL[effect]} 빼기`);
    } else {
      effects.add(effect);
      matched.add(hit);
    }
  }
  // 화면 느낌(밝기·대비·채도·빛 번짐·가장자리)과 흐름(드롭 위치·아웃트로)
  const look: Look = { ...NEUTRAL_LOOK };
  for (const rule of LOOK_RULES) if (note(rule.re)) rule.apply(look);
  const structure: { dropRatio?: number; outroBeats?: number } = {};
  for (const rule of STRUCTURE_RULES) if (note(rule.re)) rule.apply(structure);

  const scene: ScenePreference = {};
  for (const rule of SCENE_RULES) if (note(rule.re)) rule.apply(scene);
  const subjects = SUBJECT_WORDS.filter(([re]) => note(re)).map(([, term]) => term);
  if (subjects.length) scene.subjects = [...new Set(subjects)];

  // 컷 속도를 따로 말하지 않았으면 장면 분위기를 따릅니다: 격렬한 장면은 빠르게, 잔잔한 장면은 길게.
  // 분위기가 이미 그 속도(하이프는 빠름, 감성은 느림)면 한 번 더 바꾸지 않습니다.
  const scenePace = scene.intensity === "intense" && mood !== "hype" ? "fast" : scene.intensity === "calm" && mood !== "emotional" ? "slow" : undefined;
  const pace = PACE_KEYWORDS.find(([, re]) => note(re))?.[0] ?? scenePace;
  const transition = TRANSITION_KEYWORDS.find(([, re]) => note(re))?.[0];
  const paceFactor = pace ? PACE_FACTOR[pace] : 1;
  const cutBeats =
    paceFactor === 1
      ? preset.cutBeats
      : { intro: scalePattern(preset.cutBeats.intro, paceFactor), drop: scalePattern(preset.cutBeats.drop, paceFactor), outro: scalePattern(preset.cutBeats.outro, paceFactor) };
  if (/효과 ?없|깔끔|미니멀|clean|minimal/i.test(text)) {
    effects.delete("glitch");
    effects.delete("shake");
    effects.delete("grain");
  }

  const bpmMatch = /(\d{2,3})\s*bpm/i.exec(text);
  if (bpmMatch) matched.add(bpmMatch[0]);
  // "빠른 비트/템포", "느린 템포"는 분위기 기본 템포를 조금 올리거나 내립니다.
  const tempoUp = !bpmMatch && note(/빠른 ?(?:비트|템포|음악|박자)|템포 ?빠르|fast ?(?:beat|tempo)|up ?tempo/i);
  const tempoDown = !bpmMatch && !tempoUp && note(/느린 ?(?:비트|템포|음악|박자)|템포 ?느리|slow ?(?:beat|tempo)|down ?tempo/i);
  const bpm = bpmMatch ? clamp(Number(bpmMatch[1]), 60, 180) : clamp(preset.bpm + (tempoUp ? 15 : tempoDown ? -15 : 0), 60, 180);

  const searchHints = [...new Set(HINT_DICTIONARY.filter(([re]) => re.test(text)).map(([, hint]) => hint))];
  for (const word of text.match(/[A-Za-z][A-Za-z-]{2,}/g) ?? []) {
    // 검열 표시(NSFW 등)는 분위기 키워드가 아니므로 검색어에 넣지 않습니다.
    if (isNsfwRequested(word)) continue;
    // 편집 스타일을 말하는 영어 단어(fade, fast cuts, grain 등)는 영상 검색어로 쓰지 않습니다.
    const styleWord = [...Object.values(MOOD_KEYWORDS), ...GRADE_KEYWORDS.map(([, re]) => re), ...EFFECT_KEYWORDS.map(([, re]) => re), ...PACE_KEYWORDS.map(([, re]) => re), ...TRANSITION_KEYWORDS.map(([, re]) => re)].some(re => re.test(word));
    if (!styleWord && !/^(?:cuts?|edits?|style|no|without|beats?|tempo|transitions?|effects?|feel|vibe|mood)$/i.test(word) && searchHints.length < 4) searchHints.push(word.toLowerCase());
  }

  return {
    mood,
    bpm,
    bpmExplicit: Boolean(bpmMatch),
    grade,
    effects,
    cutBeats,
    weights: preset.weights,
    searchHints: searchHints.slice(0, 4),
    label: preset.label,
    pace,
    transition,
    matched: [...matched],
    scene: Object.keys(scene).length ? scene : undefined,
    look: Object.entries(look).some(([key, value]) => value !== NEUTRAL_LOOK[key as keyof Look]) ? look : undefined,
    structure: Object.keys(structure).length ? structure : undefined,
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
