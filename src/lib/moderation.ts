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
    ko: ["섹스", "야동", "포르노", "성인배우", "av배우", "성인비디오", "음란", "자위", "성인영상", "성인방송", "몰카", "야짤", "보지털", "자지털", "질싸", "펠라", "애널", "오나홀", "딸딸이", "가슴노출", "노출방송", "벗방", "조건만남", "성매매", "원조교제", "ㅅㅅ"],
    en: ["porn", "porno", "pornographic", "pornography", "pornstar", "porn star", "adult film", "adult video", "pornhub", "xvideos", "xxx", "sex", "sexy", "nude", "nudes", "nudity", "naked", "nsfw", "hentai", "onlyfans", "boobs", "pussy", "blowjob", "handjob", "cumshot", "milf", "orgasm", "fetish", "bdsm", "stripper", "striptease", "erotic", "camgirl", "gonewild", "r34", "rule34"],
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
const SAFE_PHRASES = ["시발점", "시발역", "시발택시", "시발자동차"];

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
const KO_WORDS = RULES.flatMap(rule => (rule.ko ?? []).map(word => ({ word, category: rule.category, key: compact(word.normalize("NFKC").toLowerCase()) })));

const EN_PATTERNS = RULES.flatMap(rule =>
  (rule.en ?? []).map(word => ({ word, category: rule.category, re: new RegExp(`(^|[^a-z])${escapeRegExp(word).replace(/ /g, "\\s*")}($|[^a-z])`) }))
);

export interface BlockedMatch {
  word: string;
  category: BlockCategory;
}

/** 문장에 들어 있는 금지어를 찾습니다. */
export function findBlockedWords(text: string): BlockedMatch[] {
  if (!text) return [];
  const base = normalize(text);
  const variants = [base, deleet(base)];
  const compacts = variants.map(compact);
  const found = new Map<string, BlockedMatch>();
  for (const { word, category, key } of KO_WORDS) if (compacts.some(c => c.includes(key))) found.set(word, { word, category });
  for (const { word, category, re } of EN_PATTERNS) {
    // 띄어 쓴 변형(p o r n)은 4글자 이상 단어만 붙여서 검사합니다(짧은 단어는 오탐이 많음).
    const key = word.replace(/ /g, "");
    const spaced = key.length >= 4 && compacts.some(c => new RegExp(`(^|[^a-z])${escapeRegExp(key)}($|[^a-z])`).test(c));
    if (variants.some(v => re.test(v)) || spaced) found.set(word, { word, category });
  }
  return [...found.values()];
}

export function isTextAllowed(...texts: (string | null | undefined)[]) {
  return texts.every(text => !findBlockedWords(text ?? "").length);
}

/** 사용자 입력을 검사해 막아야 하면 안내 문구를, 괜찮으면 null을 돌려줍니다. */
export function checkUserInput(topic: string, features: string): string | null {
  const hits = [...findBlockedWords(topic), ...findBlockedWords(features)];
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
export function isTopicAllowed(info: { query: string; label: string; englishLabel: string | null; description: string | null }) {
  return isTextAllowed(info.query, info.label, info.englishLabel, info.description);
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
export const SUGGESTIVE_THRESHOLD = 0.85;

export function judgeFrames(frames: FrameVerdict[]): { blocked: boolean; reason: string | null } {
  const explicit = frames.filter(f => f.porn + f.hentai >= EXPLICIT_THRESHOLD).length;
  const suggestive = frames.filter(f => f.sexy >= SUGGESTIVE_THRESHOLD).length;
  if (explicit) return { blocked: true, reason: "노골적인 장면이 감지되어 제외했어요" };
  if (suggestive >= 2) return { blocked: true, reason: "선정적인 장면이 감지되어 제외했어요" };
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

/** 미리 불러 두기 (영상 받는 동안 모델도 받아 두면 기다림이 줄어듭니다) */
export function preloadClassifier() {
  void loadClassifier().catch(() => undefined);
}

/** 영상 프레임들을 검사합니다. 검사 자체가 실패하면 안전하게 차단합니다. */
export async function screenFrames(frames: HTMLCanvasElement[]): Promise<{ blocked: boolean; reason: string | null }> {
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
  return judgeFrames(verdicts);
}
