// 주제를 해석해 관련 영상을 찾습니다. 기본은 YouTube·Reddit 위주로 라이선스와 관계없이 찾고,
// Wikimedia Commons·Internet Archive는 보충용으로 씁니다. 원하면 2차 편집이 허용되는
// 라이선스(Commons·Internet Archive)만으로 좁힐 수 있습니다.

import { searchReddit, searchYouTube } from "./social";
import { topicNames, type TopicInfo } from "./topic";

export { resolveTopic, type TopicInfo } from "./topic";

export type Provider = "YouTube" | "Reddit" | "Wikimedia Commons" | "Internet Archive";

/** reusable: 재사용 가능한 라이선스만, any: 라이선스와 관계없이 공개된 영상 전체 */
export type LicenseMode = "reusable" | "any";

export interface SourceVideo {
  id: string;
  provider: Provider;
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  /** 2차 편집이 허용되는 라이선스(Public domain, CC0, CC BY, CC BY-SA)인지 */
  reusable: boolean;
  pageUrl: string;
  mediaUrl: string;
  /** 출처가 성인 콘텐츠로 표시한 영상 (예: Reddit NSFW 게시물) — 검열 비율 계산에 쓰고 받지는 않음 */
  nsfw?: boolean;
  /** 분류·태그 등 검열에 함께 쓰는 설명 */
  tags?: string;
  /** mediaUrl을 받지 못했을 때 다시 시도할 주소 (예: 프록시) */
  fallbackUrl?: string;
  poster: string | null;
  duration: number | null;
  bytes: number | null;
  relevance: number;
}

/** 출처별 검색 결과 요약. 영상을 하나도 못 찾았을 때 이유를 보여 주는 데 씁니다. */
export interface SearchReport {
  provider: Provider;
  /** 쓸 수 있는 후보 수 */
  usable: number;
  /** 검색에 걸린 영상 수 (걸렀거나 재생할 수 없는 것 포함) */
  scanned: number;
  error?: string;
}

export type SearchStats = { scanned: number };


export const MAX_SOURCE_BYTES = 150 * 1024 * 1024;
const MIN_DURATION = 3;
const MAX_DURATION = 25 * 60;

type CanPlay = (mime: string) => boolean;

const defaultCanPlay: CanPlay = mime => {
  if (typeof document === "undefined") return true;
  return document.createElement("video").canPlayType(mime) !== "";
};

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${new URL(url).hostname} 응답 오류 (${response.status})`);
  return response.json();
}

function api(base: string, params: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams({ format: "json", origin: "*", ...params }).toString();
  return url.toString();
}


// ---------------------------------------------------------------------------
// 라이선스 허용 목록: 2차 편집이 허용되는 Public domain, CC0, CC BY, CC BY-SA만 사용합니다.

export function normalizeLicense(label: string, url?: string | null): { label: string; licenseUrl: string | null } | null {
  const text = `${label} ${url ?? ""}`.replace(/\s+/g, " ").trim();
  // 비영리(NC)·변경금지(ND) 조건은 편집물에 쓸 수 없으므로 제외합니다.
  if (/\b(NC|ND)\b|non-?commercial|no-?deriv/i.test(label) || /\/by(-sa)?-n[cd]|-n[cd][/-]/i.test(url ?? "")) return null;
  if (/cc0|publicdomain\/zero/i.test(text)) return { label: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" };
  if (/public ?domain|publicdomain\/mark|^pd\b|\bpd-/i.test(text)) return { label: "Public domain", licenseUrl: url || null };
  const labelMatch = /CC[ -]BY(-SA)?[ -]?(\d\.\d)?/i.exec(label);
  const urlMatch = /creativecommons\.org\/licenses\/(by|by-sa)\/(\d\.\d)/i.exec(url ?? "");
  const shareAlike = urlMatch ? urlMatch[1].toLowerCase() === "by-sa" : Boolean(labelMatch?.[1]);
  const version = urlMatch?.[2] ?? labelMatch?.[2];
  if (!urlMatch && !labelMatch) return null;
  if (!version) return null;
  return {
    label: `CC BY${shareAlike ? "-SA" : ""} ${version}`,
    licenseUrl: `https://creativecommons.org/licenses/${shareAlike ? "by-sa" : "by"}/${version}/`,
  };
}

/** 라이선스 모드에 따라 영상의 라이선스를 판정합니다. 쓸 수 없으면 null. */
export function resolveLicense(label: string, url: string | null, mode: LicenseMode): { label: string; licenseUrl: string | null; reusable: boolean } | null {
  const reusable = normalizeLicense(label, url);
  if (reusable) return { ...reusable, reusable: true };
  if (mode === "reusable") return null;
  return { label: label || (url ? licenseNameFromUrl(url) : "") || "라이선스 미표기", licenseUrl: url, reusable: false };
}

function licenseNameFromUrl(url: string): string {
  const match = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/i.exec(url);
  return match ? `CC ${match[1].toUpperCase()} ${match[2]}` : "";
}

export function plainText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// Wikimedia Commons

interface CommonsDerivative { src: string; type: string; width?: number; height?: number; bandwidth?: number }

/** 분석 속도를 위해 재생 가능한 360p~540p 변환본을 우선 고릅니다. */
export function pickCommonsMedia(info: any, canPlay: CanPlay = defaultCanPlay): { url: string; bytes: number | null } | null {
  const duration = Number(info?.duration) || null;
  const derivatives: CommonsDerivative[] = Array.isArray(info?.derivatives) ? info.derivatives : [];
  const playable = derivatives.filter(d => typeof d?.src === "string" && isUploadHost(d.src) && d.type && canPlay(d.type) && (d.height ?? 0) >= 240);
  const sized = playable
    .map(d => ({ d, score: Math.abs((d.height ?? 480) - 480) }))
    .sort((a, b) => a.score - b.score || (a.d.bandwidth ?? 0) - (b.d.bandwidth ?? 0));
  for (const { d } of sized) {
    const bytes = duration && d.bandwidth ? Math.round((d.bandwidth * duration) / 8) : null;
    if (bytes === null || bytes <= MAX_SOURCE_BYTES) return { url: d.src, bytes };
  }
  const size = Number(info?.size);
  if (typeof info?.url === "string" && isUploadHost(info.url) && canPlay(String(info.mime ?? "")) && size > 0 && size <= MAX_SOURCE_BYTES) {
    return { url: info.url, bytes: size };
  }
  return null;
}

function isUploadHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "upload.wikimedia.org";
  } catch {
    return false;
  }
}

export function parseCommonsPage(page: any, relevance: number, mode: LicenseMode = "reusable", canPlay: CanPlay = defaultCanPlay): SourceVideo | null {
  const info = page?.videoinfo?.[0] ?? page?.imageinfo?.[0];
  if (!info || info.mediatype !== "VIDEO") return null;
  const duration = Number(info.duration) || null;
  if (duration !== null && (duration < MIN_DURATION || duration > MAX_DURATION)) return null;
  const meta = info.extmetadata ?? {};
  const license = resolveLicense(plainText(meta.LicenseShortName?.value, 80), plainText(meta.LicenseUrl?.value, 200) || null, mode);
  if (!license) return null;
  const author = plainText(meta.Artist?.value || meta.Credit?.value, 120);
  // 저작자 표시가 필요한 라이선스인데 작성자를 알 수 없으면 재사용 모드에서는 제외합니다.
  if (!author && license.label.startsWith("CC BY") && mode === "reusable") return null;
  const media = pickCommonsMedia(info, canPlay);
  if (!media) return null;
  const title = plainText(page.title, 200).replace(/^File:/, "");
  return {
    id: `commons:${page.pageid ?? title}`,
    provider: "Wikimedia Commons",
    title: title.replace(/\.(webm|ogv|ogg|mp4|mpg|mpeg|mov)$/i, "").replace(/_/g, " "),
    author: author || "작성자 표기 없음",
    license: license.label,
    licenseUrl: license.licenseUrl,
    reusable: license.reusable,
    pageUrl: typeof info.descriptionurl === "string" ? info.descriptionurl : `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title))}`,
    mediaUrl: media.url,
    poster: typeof info.thumburl === "string" ? info.thumburl : null,
    duration,
    bytes: media.bytes,
    tags: plainText(`${meta.Categories?.value ?? ""} ${meta.ObjectName?.value ?? ""}`, 600),
    relevance,
  };
}

const COMMONS_PROPS = {
  prop: "videoinfo",
  viprop: "url|size|mime|mediatype|extmetadata|derivatives",
  viurlwidth: "480",
  viextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|Credit|Categories|ObjectName",
};

async function commonsQuery(params: Record<string, string>, signal?: AbortSignal): Promise<any[]> {
  const data = await getJson(api("https://commons.wikimedia.org/w/api.php", { action: "query", ...COMMONS_PROPS, ...params }), signal);
  return Object.values(data?.query?.pages ?? {});
}

/** Commons 검색어: 분류 → 이름(+특징) → 별칭 → 관련 주제 순. 뒤로 갈수록 관련도를 낮게 매깁니다. */
export function buildCommonsQueries(topic: TopicInfo, hints: string[]): string[] {
  const queries: string[] = [];
  const quote = (text: string) => `"${text.replace(/"/g, "")}"`;
  const names = [...new Set([topic.englishLabel, topic.query].filter((v): v is string => Boolean(v)))];
  if (topic.commonsCategory) queries.push(`filetype:video incategory:${quote(topic.commonsCategory)}`);
  for (const name of names) {
    if (hints.length) queries.push(`filetype:video ${quote(name)} ${hints.join(" ")}`);
    queries.push(`filetype:video ${quote(name)}`);
  }
  if (names[0]) queries.push(`filetype:video ${names[0]}`);
  for (const alias of (topic.aliases ?? []).slice(0, 2)) queries.push(`filetype:video ${quote(alias)}`);
  for (const related of (topic.related ?? []).slice(0, 3)) queries.push(`filetype:video ${quote(related)}`);
  return [...new Set(queries)];
}

export async function searchCommons(topic: TopicInfo, hints: string[], mode: LicenseMode, signal?: AbortSignal, stats?: SearchStats): Promise<SourceVideo[]> {
  const found = new Map<string, SourceVideo>();
  const seen = new Set<string>();
  const errors: unknown[] = [];
  const add = (pages: any[], base: number) => {
    for (const page of pages) {
      const info = page?.videoinfo?.[0] ?? page?.imageinfo?.[0];
      if (info?.mediatype === "VIDEO") seen.add(String(page.pageid ?? page.title));
      const rank = Number(page?.index) || 1;
      const source = parseCommonsPage(page, base - rank * 0.01, mode);
      if (source && !found.has(source.id)) found.set(source.id, source);
    }
  };

  if (topic.wikidataVideos.length) {
    const titles = topic.wikidataVideos.slice(0, 20).map(name => `File:${name}`).join("|");
    add(await commonsQuery({ titles }, signal).catch(() => []), 3);
  }
  const queries = buildCommonsQueries(topic, hints);
  const results = await Promise.all(
    queries.map(q =>
      commonsQuery({ generator: "search", gsrsearch: q, gsrnamespace: "6", gsrlimit: "25" }, signal).catch(error => {
        errors.push(error);
        return [];
      })
    )
  );
  results.forEach((pages, i) => add(pages, 2 - i * 0.2));
  if (stats) stats.scanned += seen.size;
  if (errors.length === queries.length && queries.length) throw errors[0];
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Internet Archive

export function pickArchiveFile(files: any[]): { name: string; bytes: number | null; duration: number | null } | null {
  const candidates = (Array.isArray(files) ? files : [])
    .filter(f => typeof f?.name === "string" && /\.mp4$/i.test(f.name))
    .map(f => ({ name: String(f.name), bytes: Number(f.size) || null, duration: parseLength(f.length) }))
    .filter(f => (f.bytes === null || f.bytes <= MAX_SOURCE_BYTES) && (f.duration === null || (f.duration >= MIN_DURATION && f.duration <= MAX_DURATION)));
  candidates.sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity));
  return candidates[0] ?? null;
}

function parseLength(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (text.includes(":")) return text.split(":").reduce((total, part) => total * 60 + Number(part), 0) || null;
  return Number(text) || null;
}

/** Internet Archive 검색어. `related`면 주제 대신 관련 주제들로 찾습니다. */
export function buildArchiveQuery(topic: TopicInfo, hints: string[], mode: LicenseMode, related = false): string {
  const names = related ? (topic.related ?? []).slice(0, 4) : topicNames(topic).filter(n => !/[\uac00-\ud7a3]/.test(n) || !topic.englishLabel).slice(0, 4);
  const any = `(${names.map(n => `"${n.replace(/"/g, "")}"`).join(" OR ")})`;
  const terms = [any, ...(related ? [] : hints)].join(" ");
  // 대출 전용(내려받기 불가) 컬렉션은 처음부터 뺍니다.
  const base = `(${terms}) AND mediatype:(movies) AND NOT collection:(inlibrary OR printdisabled)`;
  if (mode === "any") return base;
  return `${base} AND licenseurl:(*creativecommons.org/licenses/by/* OR *creativecommons.org/licenses/by-sa/* OR *publicdomain*)`;
}

export async function searchArchive(topic: TopicInfo, hints: string[], mode: LicenseMode, signal?: AbortSignal, stats?: SearchStats): Promise<SourceVideo[]> {
  const main = archiveQuery(buildArchiveQuery(topic, hints, mode), mode === "any" ? 10 : 6, 1.5, mode, signal, stats);
  // 관련 주제 검색은 보충용이라 실패해도 무시합니다.
  const related = topic.related?.length ? archiveQuery(buildArchiveQuery(topic, hints, mode, true), 4, 0.7, mode, signal, stats).catch(() => []) : Promise.resolve([]);
  const [a, b] = await Promise.all([main, related]);
  return [...a, ...b.filter(source => !a.some(other => other.id === source.id))];
}

async function archiveQuery(q: string, limit: number, base: number, mode: LicenseMode, signal?: AbortSignal, stats?: SearchStats): Promise<SourceVideo[]> {
  const url = new URL("https://archive.org/advancedsearch.php");
  url.search = new URLSearchParams({ q, rows: String(limit), output: "json", sort: "downloads desc" }).toString();
  for (const field of ["identifier", "title", "creator", "licenseurl", "subject"]) url.searchParams.append("fl[]", field);
  const data = await getJson(url.toString(), signal);
  const docs: any[] = data?.response?.docs ?? [];
  if (stats) stats.scanned += docs.length;
  const sources = await Promise.all(
    docs.map(async (doc, index): Promise<SourceVideo | null> => {
      const license = resolveLicense("", typeof doc.licenseurl === "string" ? doc.licenseurl : null, mode);
      if (!license || typeof doc.identifier !== "string") return null;
      const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`, signal).catch(() => null);
      if (meta?.is_dark || meta?.metadata?.["access-restricted-item"] === "true") return null;
      const file = pickArchiveFile(meta?.files ?? []);
      if (!file) return null;
      const creator = Array.isArray(doc.creator) ? doc.creator.join(", ") : doc.creator;
      return {
        id: `archive:${doc.identifier}`,
        provider: "Internet Archive",
        title: plainText(Array.isArray(doc.title) ? doc.title[0] : doc.title, 200) || doc.identifier,
        author: plainText(creator, 120) || "작성자 표기 없음",
        license: license.label,
        licenseUrl: license.licenseUrl,
        reusable: license.reusable,
        pageUrl: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
        mediaUrl: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
        poster: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
        duration: file.duration,
        bytes: file.bytes,
        tags: plainText(Array.isArray(doc.subject) ? doc.subject.join(", ") : doc.subject, 600),
        relevance: base - index * 0.05,
      };
    })
  );
  return sources.filter((s): s is SourceVideo => s !== null);
}

/**
 * 모든 출처를 함께 검색하고 관련도 순으로 정렬합니다.
 * YouTube는 로컬 도우미(`helper`)가 있을 때만, YouTube·Reddit은 "모든 공개 영상" 모드에서만 씁니다.
 */
export async function findSources(
  topic: TopicInfo,
  hints: string[],
  mode: LicenseMode,
  helper: string | null,
  signal?: AbortSignal
): Promise<{ sources: SourceVideo[]; reports: SearchReport[] }> {
  const reports: SearchReport[] = [];
  const run = async (provider: Provider, search: (stats: SearchStats) => Promise<SourceVideo[]>) => {
    const stats: SearchStats = { scanned: 0 };
    try {
      const sources = await search(stats);
      reports.push({ provider, usable: sources.length, scanned: Math.max(stats.scanned, sources.length) });
      return sources;
    } catch (error) {
      if (signal?.aborted) throw error;
      reports.push({ provider, usable: 0, scanned: stats.scanned, error: describeError(error) });
      return [];
    }
  };
  const social = mode === "any";
  const results = await Promise.all([
    social && helper ? run("YouTube", () => searchYouTube(topic, hints, helper, signal)) : Promise.resolve([]),
    social ? run("Reddit", stats => searchReddit(topic, hints, helper, signal, stats)) : Promise.resolve([]),
    run("Wikimedia Commons", stats => searchCommons(topic, hints, mode, signal, stats)),
    run("Internet Archive", stats => searchArchive(topic, hints, mode, signal, stats)),
  ]);
  const unique = new Map<string, SourceVideo>();
  for (const source of results.flat()) if (!unique.has(source.id)) unique.set(source.id, source);
  return { sources: rankSources([...unique.values()], topic), reports };
}

/** 브라우저의 네트워크 오류를 알아들을 수 있는 말로 바꿉니다. */
export function describeError(error: unknown): string {
  if (error instanceof TypeError) return "접속이 막혔어요(네트워크·CORS)";
  return error instanceof Error ? error.message : String(error);
}

/** 출처별 결과를 한 줄씩 사람이 읽을 수 있게 정리합니다. */
export function summarizeReports(reports: SearchReport[]): string {
  return reports
    .map(r => {
      if (r.error) return `${r.provider}: 실패 — ${r.error}`;
      if (r.usable) return `${r.provider}: ${r.usable}개`;
      if (r.scanned) return `${r.provider}: ${r.scanned}개 찾았지만 쓸 수 있는 영상 없음(길이·형식·라이선스 조건)`;
      return `${r.provider}: 검색 결과 없음`;
    })
    .join("\n");
}

export function rankSources(sources: SourceVideo[], topic: TopicInfo): SourceVideo[] {
  const names = topicNames(topic).map(n => n.toLowerCase());
  return [...sources]
    .map(source => {
      const titleHit = names.some(name => source.title.toLowerCase().includes(name)) ? 0.5 : 0;
      // 너무 짧거나 너무 긴 영상은 하이라이트를 뽑기 어렵습니다.
      const lengthFit = source.duration === null ? 0 : source.duration >= 15 && source.duration <= 600 ? 0.25 : 0;
      return { source, score: source.relevance + titleHit + lengthFit };
    })
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.source);
}

/** 크기 제한을 지키면서 영상을 내려받습니다. */
export async function downloadSource(
  source: SourceVideo,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal,
  maxBytes = MAX_SOURCE_BYTES
): Promise<Blob> {
  try {
    return await downloadFrom(source.mediaUrl, source.bytes, onProgress, signal, maxBytes);
  } catch (error) {
    if (signal?.aborted || !source.fallbackUrl) throw error;
    return downloadFrom(source.fallbackUrl, source.bytes, onProgress, signal, maxBytes);
  }
}

async function downloadFrom(
  url: string,
  expectedBytes: number | null,
  onProgress: (ratio: number) => void,
  signal: AbortSignal | undefined,
  maxBytes: number
): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    const detail = (await response.json().catch(() => null))?.error;
    throw new Error(detail ? `다운로드 실패: ${detail}` : `다운로드 실패 (${response.status})`);
  }
  const total = Number(response.headers.get("content-length")) || expectedBytes || 0;
  if (total > maxBytes) throw new Error("파일이 너무 커서 건너뛰었어요.");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("파일이 너무 커서 건너뛰었어요.");
    }
    chunks.push(value);
    if (total) onProgress(Math.min(1, received / total));
  }
  onProgress(1);
  return new Blob(chunks, { type: response.headers.get("content-type") ?? "video/mp4" });
}
