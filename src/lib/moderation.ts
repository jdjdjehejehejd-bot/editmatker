// 검열: 부적절한 단어가 들어간 입력·영상을 막고, 영상의 실제 장면을 기기 안에서 검사합니다.
//
// 1) 단어 검사 — 주제·특징 입력, 검색어, 영상 제목·채널·태그에 금지어가 있으면 쓰지 않습니다.
//    띄어쓰기·기호·숫자 치환(p0rn)·초성(ㅅㅂ) 같은 변형도 잡습니다.
// 2) 장면 검사 — NSFW.js(MobileNetV2) 모델로 영상 프레임을 분류해 선정적인 영상을 뺍니다.
//    모델은 처음 필요할 때만 내려받고, 영상은 기기 밖으로 나가지 않습니다.

export type BlockCategory = "성적" | "욕설·혐오" | "폭력·잔혹" | "약물";

interface Rule {
  category: BlockCategory;
  /** 한국어: 띄어쓰기·기호를 지운 문자열에서 부분 일치 */
  ko?: string[];
  /** 영어: 단어 경계 일치 (짧은 단어가 다른 단어 속에 들어간 경우는 무시: Sussex, class 등) */
  en?: string[];
}

const RULES: Rule[] = [
  {
    category: "성적",
    ko: ["섹스", "야동", "포르노", "성인배우", "av배우", "성인비디오", "음란", "자위", "성인영상", "성인방송", "몰카", "야짤", "보지털", "자지털", "질싸", "펠라", "애널", "오나홀", "딸딸이", "가슴노출", "노출방송", "벗방", "조건만남", "성매매", "원조교제", "ㅅㅅ", "에로틱", "에로", "섹슈얼", "섹시"],
    en: ["porn", "porno", "pornographic", "pornography", "pornstar", "porn star", "adult film", "adult video", "pornhub", "xvideos", "xxx", "sex", "sexy", "sexual", "nude", "nudes", "nudity", "naked", "nsfw", "hentai", "onlyfans", "boobs", "pussy", "blowjob", "handjob", "cumshot", "milf", "orgasm", "fetish", "bdsm", "stripper", "striptease", "erotic", "camgirl", "gonewild", "r34", "rule34"],
  },
  {
    category: "욕설·혐오",
    ko: ["씨발", "시발", "씨빨", "씨바", "ㅅㅂ", "ㅆㅂ", "병신", "ㅂㅅ", "븅신", "좆", "ㅈ같", "개새끼", "개새기", "개색기", "개색히", "ㄱㅅㄲ", "씹새끼", "니미", "느금", "엠창", "미친년", "미친놈", "썅", "지랄", "ㅈㄹ", "창녀", "걸레년", "한남충", "김치녀", "된장녀", "틀딱", "급식충", "장애인새끼", "짱깨", "쪽바리", "흑형"],
    en: ["fuck", "fucking", "motherfucker", "shit", "bitch", "bastard", "asshole", "cunt", "whore", "slut", "nigger", "nigga", "faggot", "fag", "retard", "chink", "kike", "spic", "tranny"],
  },
  {
    category: "폭력·잔혹",
    ko: ["고어영상", "참수", "살인영상", "학살영상", "시체영상", "토막살인", "자살영상", "자해", "강간", "성폭행", "아동학대", "고문영상", "처형영상"],
    en: ["gore video", "beheading", "decapitation", "snuff film", "suicide video", "selfharm", "rape", "execution video", "liveleak", "bestgore", "pedo", "pedophile"],
  },
  {
    category: "약물",
    ko: ["마약", "필로폰", "대마초", "코카인", "히로뽕"],
    en: ["cocaine", "heroin", "meth"],
  },
];

/** 금지어를 품고 있지만 멀쩡한 말 — 검사 전에 지웁니다. */
const SAFE_PHRASES = [
  "시발점", "시발역", "시발택시", "시발자동차",
  // 스포츠·일반 낱말 속에 금지어 글자가 들어 있는 경우 (선수 이름, 직업 등)
  "펠라이니", "애널리스트", "애널리틱스", "애널리시스", "자위대", "참수리",
  // "업무 에로사항"처럼 성적 낱말과 글자만 겹치는 말
  "에로사항",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/** 소문자·전각 정리. 한글 자모(ㅅㅂ)는 NFKC가 다른 문자로 바꾸므로 금지어 목록도 같은 방식으로 정리합니다. */
function normalize(text: string) {
  let value = text.normalize("NFKC").toLowerCase();
  for (const phrase of SAFE_NORMALIZED) value = value.split(phrase).join(" ");
  return value;
}

function deleet(text: string) {
  return text.replace(/[013457@$!]/g, ch => LEET[ch] ?? ch);
}

/** 띄어쓰기·기호·반복 문자 정리 (씨 발, 씨.발, 씨이발 같은 변형) */
function compact(text: string) {
  return text.replace(/[\s._\-*~·,/\\|'"`^+=()[\]{}<>?:;#%&]+/g, "").replace(/이(?=발)/g, "");
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SAFE_NORMALIZED = SAFE_PHRASES.map(p => p.normalize("NFKC"));

/** 검열 옵션. 특징·분위기에 NSFW를 적으면 성적 콘텐츠 검사만 끕니다. */
export interface ModerationOptions {
  nsfw?: boolean;
  /** 스포츠 주제(격투기·수영 등 맨살이 많이 보이는 경기) — 노출만으로는 막지 않고 노골적인 장면만 봅니다 */
  sports?: boolean;
}

/** NSFW 모드를 켜는 표시 — 띄어쓰기·기호(N.S.F.W, n s f w)도 같은 말로 봅니다.
 *  성적 표현(에로틱·섹슈얼·섹시 등)은 표시가 아니라 성적 낱말이라, 이것만 적으면 NSFW는 꺼진 채로 막힙니다. */
const NSFW_MARKERS = ["nsfw", "무검열", "노검열", "검열해제", "검열없", "19금"];
const NSFW_LOOSE = /uncensored|no\s*censor|19\+/i;

/** 특징·분위기 문장에 NSFW 표시가 있는지 */
export function isNsfwRequested(features: string | null | undefined): boolean {
  const text = (features ?? "").normalize("NFKC");
  if (!text.trim()) return false;
  if (NSFW_LOOSE.test(text)) return true;
  const squashed = compact(text.toLowerCase());
  return NSFW_MARKERS.some(marker => squashed.includes(marker));
}

interface KoRule {
  word: string;
  category: BlockCategory;
  key: string;
}

interface EnRule {
  word: string;
  category: BlockCategory;
  re: RegExp;
  /** 띄어 쓴 변형(p o r n)을 붙여서 찾는 정규식 — 4글자 이상 단어만 (짧은 단어는 오탐이 많음) */
  spacedRe: RegExp | null;
}

function buildKoRules(rules: Rule[]): KoRule[] {
  return rules.flatMap(rule => (rule.ko ?? []).map(word => ({ word, category: rule.category, key: compact(word.normalize("NFKC").toLowerCase()) })));
}

function buildEnRules(rules: Rule[]): EnRule[] {
  return rules.flatMap(rule =>
    (rule.en ?? []).map(word => {
      const key = word.replace(/ /g, "");
      return {
        word,
        category: rule.category,
        re: new RegExp(`(^|[^a-z])${escapeRegExp(word).replace(/ /g, "\\s*")}($|[^a-z])`),
        spacedRe: key.length >= 4 ? new RegExp(`(^|[^a-z])${escapeRegExp(key)}($|[^a-z])`) : null,
      };
    })
  );
}

const KO_WORDS = buildKoRules(RULES);
const EN_PATTERNS = buildEnRules(RULES);

/** NSFW 모드에서 쓰는 목록 — 성적 카테고리만 빠지고, 아동·비동의·잔혹·약물은 그대로 남습니다. */
const KO_WORDS_STRICT = buildKoRules(RULES.filter(rule => rule.category !== "성적"));
const EN_PATTERNS_STRICT = buildEnRules(RULES.filter(rule => rule.category !== "성적"));

export interface BlockedMatch {
  word: string;
  category: BlockCategory;
}

/** 문장에 들어 있는 금지어를 찾습니다. options.nsfw면 성적 단어는 검사하지 않습니다. */
export function findBlockedWords(text: string, options: ModerationOptions = {}): BlockedMatch[] {
  if (!text) return [];
  const koWords = options.nsfw ? KO_WORDS_STRICT : KO_WORDS;
  const enPatterns = options.nsfw ? EN_PATTERNS_STRICT : EN_PATTERNS;
  const base = normalize(text);
  const variants = [base, deleet(base)];
  const compacts = variants.map(compact);
  const found = new Map<string, BlockedMatch>();
  for (const { word, category, key } of koWords) if (compacts.some(c => c.includes(key))) found.set(word, { word, category });
  for (const { word, category, re, spacedRe } of enPatterns) {
    if (variants.some(v => re.test(v)) || (spacedRe && compacts.some(c => spacedRe.test(c)))) found.set(word, { word, category });
  }
  return [...found.values()];
}

/** 문장에 성적 낱말이 들어 있는지 — NSFW 모드에서 편집 결(감성 분위기·따뜻한 색)을 자동으로 맞출 때 씁니다. */
export function hasSexualWords(text: string): boolean {
  return findBlockedWords(text).some(hit => hit.category === "성적");
}

export function isTextAllowed(...texts: (string | null | undefined)[]) {
  return isTextAllowedWith({}, ...texts);
}

/** 검열 옵션을 적용해 검사합니다. */
export function isTextAllowedWith(options: ModerationOptions, ...texts: (string | null | undefined)[]) {
  return texts.every(text => !findBlockedWords(text ?? "", options).length);
}

/**
 * 사용자 입력을 검사해 막아야 하면 안내 문구를, 괜찮으면 null을 돌려줍니다.
 * 특징·분위기에 NSFW를 적었으면 성적 콘텐츠 검사만 건너뛰고 나머지는 그대로 검사합니다.
 */
export function checkUserInput(topic: string, features: string): string | null {
  const options: ModerationOptions = { nsfw: isNsfwRequested(features) };
  const hits = [...findBlockedWords(topic, options), ...findBlockedWords(features, options)];
  if (!hits.length) return null;
  const categories = [...new Set(hits.map(h => h.category))].join(", ");
  return `생성 불가 — 부적절한 단어(${categories})가 들어 있어요. 해당 단어를 빼고 다시 입력해 주세요.`;
}

// ---------------------------------------------------------------------------
// 주제 단위 차단: 주제 자체나, 그 주제로 찾은 영상 상당수가 검열 대상이면 아예 만들지 않습니다.

/** 생성 자체를 막는 오류 (화면에 "생성 불가"로 표시) */
export class GenerationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationBlockedError";
  }
}

/** 찾은 영상 중 이 비율 이상이 검열 대상이면 주제를 막습니다(우연한 1개는 봐주도록 최소 2개). */
export const CENSOR_RATIO = 0.3;
export const CENSOR_MIN = 2;

export function shouldBlockTopic(censored: number, total: number): boolean {
  return total > 0 && censored >= CENSOR_MIN && censored / total >= CENSOR_RATIO;
}

/** 해석된 주제(영어 이름, Wikidata 설명)에 금지어가 있는지 — 예: 설명이 "pornographic actress"인 인물 */
export function isTopicAllowed(info: { query: string; label: string; englishLabel: string | null; description: string | null }, options: ModerationOptions = {}) {
  return isTextAllowedWith(options, info.query, info.label, info.englishLabel, info.description);
}

// ---------------------------------------------------------------------------
// 장면 검사

export interface FrameVerdict {
  porn: number;
  hentai: number;
  sexy: number;
}

/** 선정성 판정 기준: 노골적(Porn+Hentai) 0.6 이상 한 장면, 또는 선정적(Sexy) 0.85 이상 두 장면 */
export const EXPLICIT_THRESHOLD = 0.6;
/** 이 이상이면 한 장면만으로도 노골적이라고 봅니다 */
export const EXPLICIT_STRONG = 0.85;
export const SUGGESTIVE_THRESHOLD = 0.85;
/** 선정성(노출) 판정에 필요한 장면 수 — 한두 장면의 오탐(상의 탈의 등)으로 막지 않게 */
export const SUGGESTIVE_MIN_FRAMES = 3;

/** 스포츠 영상의 노골적 판정 기준 — 격투기·레슬링·수영처럼 맨살과 몸싸움이 많은 장면을 모델이 자주 잘못 봅니다. */
export const SPORTS_EXPLICIT_STRONG = 0.97;
export const SPORTS_EXPLICIT_LIKELY = 0.85;
export const SPORTS_LIKELY_FRAMES = 3;

/**
 * 장면 판정. 판별 모델은 맨살이 많이 보이면(격투기·수영·보디빌딩 등) 선정적이라고 잘못 보는 경우가 많아서:
 * - 노골적: 아주 확실한 장면 1개(0.85 이상) 또는 비교적 확실한 장면 2개(0.6 이상)
 * - 선정적(노출): 3개 이상일 때만, 스포츠 영상은 보지 않음
 * - 스포츠 영상은 노골적 기준도 훨씬 높게(0.97 1개 또는 0.85 3개)
 * `certain`은 의심할 여지가 거의 없는 장면이 있었는지 — 스포츠 주제 전체를 막을지 정할 때 씁니다.
 */
export function judgeFrames(frames: FrameVerdict[], options: ModerationOptions = {}): { blocked: boolean; reason: string | null; certain?: boolean } {
  const strong = options.sports ? SPORTS_EXPLICIT_STRONG : EXPLICIT_STRONG;
  const likely = options.sports ? SPORTS_EXPLICIT_LIKELY : EXPLICIT_THRESHOLD;
  const likelyFrames = options.sports ? SPORTS_LIKELY_FRAMES : 2;
  const explicitScore = (f: FrameVerdict) => f.porn + f.hentai;
  const strongCount = frames.filter(f => explicitScore(f) >= strong).length;
  const likelyCount = frames.filter(f => explicitScore(f) >= likely).length;
  if (strongCount >= 1 || likelyCount >= likelyFrames) return { blocked: true, reason: "노골적인 장면이 감지되어 제외했어요", certain: frames.some(f => explicitScore(f) >= SPORTS_EXPLICIT_STRONG) };
  const suggestive = frames.filter(f => f.sexy >= SUGGESTIVE_THRESHOLD).length;
  if (!options.sports && suggestive >= SUGGESTIVE_MIN_FRAMES) return { blocked: true, reason: "선정적인 장면이 감지되어 제외했어요", certain: false };
  return { blocked: false, reason: null };
}

type Classifier = { classify(input: HTMLCanvasElement): Promise<{ className: string; probability: number }[]> };
let classifier: Promise<Classifier> | null = null;

/** NSFW.js 모델을 처음 쓸 때 한 번만 불러옵니다(약 3.5MB, 별도 파일로 나뉘어 있음). */
function loadClassifier(): Promise<Classifier> {
  classifier ??= (async () => {
    const [tf, { load }, { MobileNetV2Model }] = await Promise.all([import("@tensorflow/tfjs"), import("nsfwjs/core"), import("nsfwjs/models/mobilenet_v2")]);
    tf.enableProdMode();
    await tf.ready();
    return (await load("MobileNetV2", { modelDefinitions: [MobileNetV2Model] })) as unknown as Classifier;
  })().catch(error => {
    classifier = null;
    throw error;
  });
  return classifier;
}

/** 미리 불러 두기 (영상 받는 동안 모델도 받아 두면 기다림이 줄어듭니다). NSFW 모드에서는 모델을 받지 않습니다. */
export function preloadClassifier(options: ModerationOptions = {}) {
  if (options.nsfw) return;
  void loadClassifier().catch(() => undefined);
}

/** 영상 프레임들을 검사합니다. 검사 자체가 실패하면 안전하게 차단합니다. */
export async function screenFrames(frames: HTMLCanvasElement[], options: ModerationOptions = {}): Promise<{ blocked: boolean; reason: string | null; certain?: boolean }> {
  // NSFW 모드면 장면 검사(모델 다운로드 포함)를 하지 않습니다.
  if (options.nsfw) return { blocked: false, reason: null };
  if (!frames.length) return { blocked: false, reason: null };
  let model: Classifier;
  try {
    model = await loadClassifier();
  } catch {
    return { blocked: true, reason: "장면 검열 모델을 불러오지 못해 안전을 위해 제외했어요" };
  }
  const verdicts: FrameVerdict[] = [];
  for (const frame of frames) {
    const predictions = await model.classify(frame);
    const p = (name: string) => predictions.find(x => x.className === name)?.probability ?? 0;
    verdicts.push({ porn: p("Porn"), hentai: p("Hentai"), sexy: p("Sexy") });
  }
  return judgeFrames(verdicts, options);
}
