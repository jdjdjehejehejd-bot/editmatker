// 주제 해석과 검색어 확장.
// Wikidata·Wikipedia(키 없이 CORS 허용)로 주제의 영어 이름, 다른 이름(별칭), 관련 주제를 찾아
// 입력값 하나만이 아니라 여러 검색어로 영상을 찾게 합니다.

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
  for (const language of languages) {
    const search = await getJson(
      api("https://www.wikidata.org/w/api.php", { action: "wbsearchentities", search: query, language, uselang: language, type: "item", limit: "1" }),
      signal
    ).catch(() => null);
    const id = search?.search?.[0]?.id;
    if (typeof id === "string") return id;
  }
  for (const language of languages) {
    const data = await getJson(
      api(`https://${language}.wikipedia.org/w/api.php`, {
        action: "query", generator: "search", gsrsearch: query, gsrlimit: "1", prop: "pageprops", ppprop: "wikibase_item",
      }),
      signal
    ).catch(() => null);
    const page: any = Object.values(data?.query?.pages ?? {})[0];
    const id = page?.pageprops?.wikibase_item;
    if (typeof id === "string") return id;
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

export async function resolveTopic(query: string, signal?: AbortSignal): Promise<TopicInfo> {
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
      aliases: pickAliases(entity, [query, label, englishLabel ?? ""]),
      related,
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
  for (const related of (topic.related ?? []).slice(0, 3)) push(related, 0.6, "related");
  return list.slice(0, max);
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
  for (const part of input.split(/[,，、\n]/)) {
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
