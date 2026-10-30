// 주제 해석과 검색어 확장.
// Wikidata·Wikipedia(키 없이 CORS 허용)로 주제의 영어 이름, 다른 이름(별칭), 관련 주제를 찾아
// 입력값 하나만이 아니라 여러 검색어로 영상을 찾게 합니다.

import { isTextAllowedWith, type ModerationOptions } from "./moderation";

export interface TopicInfo {
  query: string;
  label: string;
  englishLabel: string | null;
  description: string | null;
  commonsCategory: string | null;
  wikidataVideos: string[];
  /** 영어·한국어 다른 이름 (예: "Sonny", "쏘니") */
  aliases?: string[];
  /** 관련 주제의 이름 (예: 소속 팀, 그룹, 종목, 대표작) */
  related?: string[];
  /** 스포츠 선수·경기 주제인지 (장면 검열에서 경기 중 노출을 오탐하지 않으려고) */
  sports?: boolean;
}

const SPORTS_WORDS = /athlete|player|footballer|fighter|boxer|wrestler|martial art|\bmma\b|ufc|swimmer|sprinter|cyclist|gymnast|bodybuilder|skater|tennis|golfer|olympi|선수|격투|복서|레슬러|수영|육상|체조|보디빌|축구|야구|농구|배구|테니스|골프|올림픽/i;

/** 문장에 선수·경기 관련 말이 있는지 (주제를 Wikidata에서 못 찾았을 때 특징·분위기 문장으로 보조 판단) */
export function mentionsSports(text: string | null | undefined): boolean {
  return SPORTS_WORDS.test(text ?? "") || /경기|시합|하이라이트|\bko\b|knockout|녹아웃|골|득점|스포츠|sports?/i.test(text ?? "");
}

/** Wikidata의 종목(P641)·소속 팀(P54)이 있거나 설명에 선수·경기 관련 말이 있으면 스포츠 주제 */
export function isSportsEntity(entity: any): boolean {
  if (entity?.claims?.P641?.length || entity?.claims?.P54?.length) return true;
  const descriptions = [entity?.descriptions?.en?.value, entity?.descriptions?.ko?.value].filter(Boolean).join(" ");
  return SPORTS_WORDS.test(descriptions);
}

export interface SearchQuery {
  q: string;
  /** 1이면 주제 그대로, 낮을수록 넓힌 검색어 (관련도 점수에 반영) */
  weight: number;
  kind: "name" | "alias" | "related";
}

const HANGUL = /[가-힣]/;
const EXPAND_TIMEOUT_MS = 6000;

/** 관련 주제로 쓸 Wikidata 속성: 소속 팀, 소속 단체, 구성원, 상위 개념, 참가 행사, 종목, 장르, 대표작, 상위 분류, 위치 */
export const RELATED_PROPERTIES = ["P54", "P463", "P527", "P361", "P1344", "P641", "P136", "P800", "P279", "P131"];
const MAX_RELATED = 6;

function api(base: string, params: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams({ format: "json", origin: "*", ...params }).toString();
  return url.toString();
}

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${new URL(url).hostname} 응답 오류 (${response.status})`);
  return response.json();
}

/** 실패하거나 오래 걸리면 기본값을 돌려줍니다. 검색어 확장은 있으면 좋은 정도라서 전체를 막지 않습니다. */
async function optional<T>(promise: Promise<T>, fallback: T, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>(resolve => (timer = setTimeout(() => resolve(fallback), EXPAND_TIMEOUT_MS)))]);
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** 엔티티의 관련 항목 ID를 고릅니다. 기간이 끝난 관계(예: 예전 소속 팀)보다 현재 관계를 먼저 씁니다. */
export function pickRelatedIds(entity: any): string[] {
  const ids: string[] = [];
  for (const property of RELATED_PROPERTIES) {
    const claims: any[] = entity?.claims?.[property] ?? [];
    const current = claims.filter(c => !c?.qualifiers?.P582);
    const ordered = [...current.reverse(), ...claims.filter(c => c?.qualifiers?.P582).reverse()];
    for (const claim of ordered.slice(0, 2)) {
      const id = claim?.mainsnak?.datavalue?.value?.id;
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    if (ids.length >= MAX_RELATED) break;
  }
  return ids.slice(0, MAX_RELATED);
}

export function pickAliases(entity: any, exclude: string[]): string[] {
  const seen = new Set(exclude.filter(Boolean).map(name => name.toLowerCase()));
  const aliases: string[] = [];
  for (const lang of ["en", "ko"]) {
    for (const alias of entity?.aliases?.[lang] ?? []) {
      const value = typeof alias?.value === "string" ? alias.value.trim() : "";
      // 한 글자 약칭이나 너무 긴 정식 명칭은 검색어로 쓰기 어렵습니다.
      if (value.length < 2 || value.length > 40 || seen.has(value.toLowerCase())) continue;
      seen.add(value.toLowerCase());
      aliases.push(value);
    }
  }
  return aliases.slice(0, 4);
}

/** Wikidata 직접 검색이 실패하면 Wikipedia 검색으로 문서를 찾아 연결된 Wikidata 항목을 얻습니다. */
async function findEntityId(query: string, signal?: AbortSignal): Promise<string | null> {
  const languages = HANGUL.test(query) ? ["ko", "en"] : ["en", "ko"];
  const wikidata = (language: string) =>
    getJson(api("https://www.wikidata.org/w/api.php", { action: "wbsearchentities", search: query, language, uselang: language, type: "item", limit: "1" }), signal)
      .then(search => (typeof search?.search?.[0]?.id === "string" ? (search.search[0].id as string) : null))
      .catch(() => null);
  const wikipedia = (language: string) =>
    getJson(
      api(`https://${language}.wikipedia.org/w/api.php`, { action: "query", generator: "search", gsrsearch: query, gsrlimit: "1", prop: "pageprops", ppprop: "wikibase_item" }),
      signal
    )
      .then(data => {
        const page: any = Object.values(data?.query?.pages ?? {})[0];
        return typeof page?.pageprops?.wikibase_item === "string" ? (page.pageprops.wikibase_item as string) : null;
      })
      .catch(() => null);
  // 속도: 네 가지 찾기를 한꺼번에 보내고, 우선순위(Wikidata 한국어 → 영어 → Wikipedia 한국어 → 영어) 순으로 첫 결과를 씁니다.
  const lookups = [...languages.map(wikidata), ...languages.map(wikipedia)];
  for (const lookup of lookups) {
    const id = await lookup;
    if (id) return id;
  }
  return null;
}

async function relatedLabels(ids: string[], signal?: AbortSignal): Promise<string[]> {
  if (!ids.length) return [];
  const data = await getJson(api("https://www.wikidata.org/w/api.php", { action: "wbgetentities", ids: ids.join("|"), props: "labels", languages: "en|ko" }), signal);
  return ids
    .map(id => data?.entities?.[id]?.labels?.en?.value ?? data?.entities?.[id]?.labels?.ko?.value)
    .filter((label: unknown): label is string => typeof label === "string");
}

/** 영어 Wikipedia의 "비슷한 문서" 검색으로 관련 주제를 찾습니다. */
async function similarArticles(enwikiTitle: string | null, signal?: AbortSignal): Promise<string[]> {
  if (!enwikiTitle) return [];
  const data = await getJson(
    api("https://en.wikipedia.org/w/api.php", { action: "query", list: "search", srsearch: `morelike:${enwikiTitle}`, srlimit: "4", srnamespace: "0", srprop: "" }),
    signal
  );
  return (data?.query?.search ?? []).map((hit: any) => hit?.title).filter((title: unknown): title is string => typeof title === "string");
}

export async function resolveTopic(query: string, signal?: AbortSignal, options: ModerationOptions = {}): Promise<TopicInfo> {
  const fallback: TopicInfo = { query, label: query, englishLabel: null, description: null, commonsCategory: null, wikidataVideos: [], aliases: [], related: [] };
  try {
    const id = await findEntityId(query, signal);
    if (!id) return fallback;
    const data = await getJson(
      api("https://www.wikidata.org/w/api.php", { action: "wbgetentities", ids: id, props: "labels|aliases|descriptions|claims|sitelinks", languages: "en|ko", sitefilter: "enwiki" }),
      signal
    );
    const entity = data?.entities?.[id];
    const claimValues = (property: string): string[] =>
      (entity?.claims?.[property] ?? []).map((claim: any) => claim?.mainsnak?.datavalue?.value).filter((value: unknown): value is string => typeof value === "string");
    const label = entity?.labels?.ko?.value ?? query;
    const englishLabel = entity?.labels?.en?.value ?? null;
    const [fromClaims, similar] = await Promise.all([
      optional(relatedLabels(pickRelatedIds(entity), signal), [], signal),
      optional(similarArticles(entity?.sitelinks?.enwiki?.title ?? null, signal), [], signal),
    ]);
    const names = [query, label, englishLabel].filter((v): v is string => Boolean(v)).map(n => n.toLowerCase());
    const related = [...new Set([...fromClaims, ...similar])].filter(r => !names.includes(r.toLowerCase())).slice(0, MAX_RELATED);
    return {
      query,
      label,
      englishLabel,
      description: entity?.descriptions?.ko?.value ?? entity?.descriptions?.en?.value ?? null,
      commonsCategory: claimValues("P373")[0] ?? null,
      wikidataVideos: claimValues("P10"),
      sports: isSportsEntity(entity),
      // 별칭·관련 주제에 금지어가 섞여 있으면 검색어로 쓰지 않습니다.
      aliases: pickAliases(entity, [query, label, englishLabel ?? ""]).filter(alias => isTextAllowedWith(options, alias)),
      related: related.filter(item => isTextAllowedWith(options, item)),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallback;
  }
}

/** 주제를 부르는 모든 이름 (입력값, 한국어·영어 이름, 별칭) */
export function topicNames(topic: TopicInfo): string[] {
  return [...new Set([topic.query, topic.label, topic.englishLabel, ...(topic.aliases ?? [])].filter((v): v is string => Boolean(v?.trim())).map(v => v.trim()))];
}

/**
 * YouTube·Reddit에 보낼 검색어 목록.
 * 1) 한국어 이름  2) 영어 이름 + 특징 키워드  3) 영어 이름만  4) 별칭  5) 관련 주제
 */
export function expandQueries(topic: TopicInfo, hints: string[], max = 7): SearchQuery[] {
  const korean = [topic.query, topic.label].find(name => HANGUL.test(name));
  const english = topic.englishLabel ?? (HANGUL.test(topic.query) ? null : topic.query);
  const list: SearchQuery[] = [];
  const push = (q: string | null | undefined, weight: number, kind: SearchQuery["kind"]) => {
    const value = q?.trim();
    if (value && !list.some(item => item.q.toLowerCase() === value.toLowerCase())) list.push({ q: value, weight, kind });
  };
  push(korean, 1, "name");
  if (english) push([english, ...hints].join(" "), 1, "name");
  if (english && hints.length) push(english, 0.95, "name");
  for (const alias of (topic.aliases ?? []).slice(0, 2)) push(alias, 0.85, "alias");
  // 관련 주제는 단독으로 검색하면 엉뚱한 영상이 나오므로 항상 주제 이름과 함께 검색합니다.
  const anchor = english ?? korean ?? topic.query;
  for (const related of (topic.related ?? []).slice(0, 3)) push(`${anchor} ${related}`, 0.6, "related");
  return list.slice(0, max);
}

// ---------------------------------------------------------------------------
// 관련성 판정: 영상 제목·설명에 주제 이름이 실제로 나오는지

/** 소문자, 악센트 제거(é → e), 글자·숫자만 남기기 */
function fold(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function compactFold(text: string) {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

function words(text: string) {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * 영상 정보(제목·태그·채널)에 주제 이름이 나오면 true.
 * - 한국어 이름: 띄어쓰기를 무시하고 포함 여부 ("손 흥민" → 손흥민)
 * - 영어 이름: 기호를 무시하고 포함 ("Son Heungmin", "SON HEUNG-MIN"), 또는 이름의 단어가 순서와 상관없이 모두 나옴 ("Heung-min Son")
 * - 짧은 영어 이름(BTS, IU)은 다른 단어 속에 들어간 경우를 빼려고 단어 단위로만 비교
 */
export function matchesTopic(text: string, topic: TopicInfo): boolean {
  return createTopicMatcher(topic)(text);
}

/** 주제 이름들을 미리 정리해 둔 판정 함수 — 영상이 많을 때 matchesTopic을 반복 호출하는 것보다 빠릅니다. */
export function createTopicMatcher(topic: TopicInfo): (text: string) => boolean {
  const names = topicNames(topic).map(name => ({ key: compactFold(name), latin: !HANGUL.test(name), parts: words(name).filter(part => part.length >= 2) }));
  return text => {
    const haystack = compactFold(text);
    const tokens = new Set(words(text));
    for (const { key, latin, parts } of names) {
      if (!key) continue;
      if (!latin) {
        if (key.length >= 2 && haystack.includes(key)) return true;
        continue;
      }
      if (key.length < 4) {
        if (tokens.has(key) || (parts.length > 1 && parts.every(part => tokens.has(part)))) return true;
        continue;
      }
      if (haystack.includes(key)) return true;
      if (parts.length > 1 && parts.every(part => tokens.has(part))) return true;
    }
    return false;
  };
}

// ---------------------------------------------------------------------------
// 여러 주제 입력: "손흥민, 3:케인:, 토트넘" → 쉼표로 나누고, N:단어: 는 N배 비중

export interface TopicSpec {
  term: string;
  weight: number;
}

export const MAX_TOPICS = 6;
const WEIGHTED = /^(\d+(?:\.\d+)?)\s*[:：]\s*(.+?)\s*[:：]?$/;

export function parseTopicInput(input: string): TopicSpec[] {
  const specs: TopicSpec[] = [];
  // 쉼표 외에 줄바꿈, |, ·, 앞뒤를 띄운 / 와 + 로도 나눕니다("AC/DC"·"Tom & Jerry"처럼 이름 속 기호는 그대로).
  for (const part of input.split(/[,，、\n|·]|\s[/+]\s/)) {
    const text = part.trim();
    if (!text) continue;
    let match = WEIGHTED.exec(text);
    // "12:00 뉴스"처럼 끝 콜론 없이 숫자가 이어지면 비중 표시가 아니라 주제명으로 봅니다.
    if (match && !/[:：]$/.test(text) && /^\d/.test(match[2])) match = null;
    const term = (match ? match[2] : text).replace(/^[:：]+|[:：]+$/g, "").trim();
    const weight = match ? Math.min(10, Math.max(0.1, Number(match[1]))) : 1;
    if (!term) continue;
    const existing = specs.find(spec => spec.term.toLowerCase() === term.toLowerCase());
    if (existing) existing.weight = Math.max(existing.weight, weight);
    else specs.push({ term, weight });
  }
  return specs.slice(0, MAX_TOPICS);
}

/**
 * 전체 칸 수를 가중치에 비례해 나눕니다(최대 나머지 방식).
 * 칸이 주제 수보다 많으면 모든 주제가 최소 1칸을 받습니다.
 */
export function allocateSlots(weights: number[], total: number): number[] {
  const n = weights.length;
  if (!n || total <= 0) return weights.map(() => 0);
  const order = weights.map((w, i) => i).sort((a, b) => weights[b] - weights[a]);
  const result = weights.map(() => 0);
  let remaining = total;
  if (total >= n) {
    result.fill(1);
    remaining -= n;
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map(w => (w / sum) * total);
  // 이미 받은 1칸을 빼고 모자란 만큼을 나눕니다.
  const want = exact.map((e, i) => Math.max(0, e - result[i]));
  const floors = want.map(w => Math.floor(w));
  const floorSum = floors.reduce((a, b) => a + b, 0);
  if (floorSum > remaining) {
    // 정수 부분만으로도 넘치면 가중치가 큰 주제부터 채웁니다.
    for (const i of order) {
      const take = Math.min(floors[i], remaining);
      result[i] += take;
      remaining -= take;
    }
    return result;
  }
  floors.forEach((f, i) => (result[i] += f));
  remaining -= floorSum;
  const byRemainder = want.map((w, i) => i).sort((a, b) => want[b] - floors[b] - (want[a] - floors[a]) || weights[b] - weights[a]);
  for (const i of byRemainder) {
    if (remaining <= 0) break;
    result[i]++;
    remaining--;
  }
  return result;
}

/** 편집 제목: "손흥민 × 케인 × 토트넘" */
export function combinedTitle(labels: string[]): string {
  if (labels.length <= 3) return labels.join(" × ");
  return `${labels.slice(0, 3).join(" × ")} 외 ${labels.length - 3}`;
}
