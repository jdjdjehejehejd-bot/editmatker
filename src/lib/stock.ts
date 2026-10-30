// 스톡 영상(Pexels·Pixabay·Mixkit) 검색. 세 곳 모두 무료로 수정·상업 이용이 허용되는 자체 라이선스라
// "재사용 가능만" 모드에서도 씁니다. Pexels·Pixabay는 API 키가 필요하고(설정에 입력하거나 Vercel 환경 변수),
// Mixkit은 API가 없어 같은 사이트의 /api/stock 프록시가 받아 온 검색 페이지에서 영상을 찾습니다.

import { stockRequest, type StockProvider } from "../../api/_stock";
import { LIMITS } from "./device";
import { proxyBase } from "./social";
import { reject, REASON, type Provider, type SearchStats, type SourceVideo } from "./sources";
import type { TopicInfo } from "./topic";

export interface StockKeys {
  pexels: string;
  pixabay: string;
}

const KEYS_STORAGE = "editmatker.stockKeys.v1";
const HANGUL = /[ㄱ-힝]/;
const MIN_DURATION = 3;
const MAX_DURATION = 10 * 60;

const LICENSE: Record<StockProvider, { label: string; url: string }> = {
  pexels: { label: "Pexels License", url: "https://www.pexels.com/license/" },
  pixabay: { label: "Pixabay Content License", url: "https://pixabay.com/service/license-summary/" },
  mixkit: { label: "Mixkit Free License", url: "https://mixkit.co/license/#videoFree" },
};

const PROVIDER_NAME: Record<StockProvider, Provider> = { pexels: "Pexels", pixabay: "Pixabay", mixkit: "Mixkit" };

export function loadStockKeys(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): StockKeys {
  try {
    const data = JSON.parse(storage?.getItem(KEYS_STORAGE) ?? "{}");
    return { pexels: typeof data?.pexels === "string" ? data.pexels : "", pixabay: typeof data?.pixabay === "string" ? data.pixabay : "" };
  } catch {
    return { pexels: "", pixabay: "" };
  }
}

export function saveStockKeys(keys: StockKeys, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(KEYS_STORAGE, JSON.stringify({ pexels: keys.pexels.trim(), pixabay: keys.pixabay.trim() }));
  } catch {
    /* 저장 불가 */
  }
}

/** 이 기기에서 받을 영상 높이 상한 (휴대폰은 720p, PC는 1080p) */
const maxHeight = () => (LIMITS.sourceBytes < 100 * 1024 * 1024 ? 720 : 1080);

/** 페이지 주소의 마지막 조각을 제목으로 ("/video/tokyo-tower-at-night-123/" → "tokyo tower at night") */
export function slugTitle(url: string): string {
  try {
    const last = new URL(url, "https://example.com").pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last).replace(/-?\d+$/, "").replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/** 높이 상한 이하에서 가장 큰 화질, 없으면 가장 작은 화질 */
export function pickBySize<T extends { height: number }>(files: T[], limit: number): T | null {
  if (!files.length) return null;
  const fitting = files.filter(f => f.height <= limit).sort((a, b) => b.height - a.height);
  return fitting[0] ?? [...files].sort((a, b) => a.height - b.height)[0];
}

function stockSource(provider: StockProvider, item: Omit<SourceVideo, "provider" | "license" | "licenseUrl" | "reusable" | "fallbackUrl">): SourceVideo {
  return {
    ...item,
    provider: PROVIDER_NAME[provider],
    license: LICENSE[provider].label,
    licenseUrl: LICENSE[provider].url,
    reusable: true,
    // 브라우저가 영상 서버에서 직접 못 받으면(CORS) 같은 사이트의 /api/media 프록시로 다시 시도합니다.
    fallbackUrl: `${proxyBase()}/api/media?url=${encodeURIComponent(item.mediaUrl)}`,
  };
}

function inRange(duration: number | null, stats?: SearchStats) {
  if (duration === null || (duration >= MIN_DURATION && duration <= MAX_DURATION)) return true;
  reject(stats, REASON.length);
  return false;
}

/** Pexels /videos/search 응답 → 영상 목록 */
export function parsePexels(data: any, relevance: number, limit = maxHeight(), stats?: SearchStats): SourceVideo[] {
  const videos: any[] = Array.isArray(data?.videos) ? data.videos : [];
  if (stats) stats.scanned += videos.length;
  return videos.flatMap((video, index) => {
    const duration = Number.isFinite(video?.duration) ? Number(video.duration) : null;
    if (!inRange(duration, stats)) return [];
    const files: { link: string; height: number }[] = (Array.isArray(video?.video_files) ? video.video_files : [])
      .filter((f: any) => typeof f?.link === "string" && (f.file_type ?? "video/mp4") === "video/mp4")
      .map((f: any): { link: string; height: number } => ({ link: f.link, height: Number(f.height) || 0 }));
    const file = pickBySize(files, limit);
    if (!file) {
      reject(stats, REASON.noVideo);
      return [];
    }
    const pageUrl = typeof video.url === "string" ? video.url : `https://www.pexels.com/video/${video.id}/`;
    const tags = Array.isArray(video.tags) ? video.tags.filter((t: unknown) => typeof t === "string").join(", ") : "";
    return [
      stockSource("pexels", {
        id: `pexels:${video.id}`,
        title: slugTitle(pageUrl) || tags || "Pexels 영상",
        author: typeof video.user?.name === "string" ? video.user.name : "Pexels",
        pageUrl,
        mediaUrl: file.link,
        poster: typeof video.image === "string" ? video.image : null,
        duration,
        bytes: null,
        tags: tags || undefined,
        relevance: relevance - index * 0.03,
      }),
    ];
  });
}

/** Pixabay /api/videos 응답 → 영상 목록 */
export function parsePixabay(data: any, relevance: number, limit = maxHeight(), stats?: SearchStats): SourceVideo[] {
  const hits: any[] = Array.isArray(data?.hits) ? data.hits : [];
  if (stats) stats.scanned += hits.length;
  return hits.flatMap((hit, index) => {
    const duration = Number.isFinite(hit?.duration) ? Number(hit.duration) : null;
    if (!inRange(duration, stats)) return [];
    const files = Object.values(hit?.videos ?? {})
      .filter((f: any) => typeof f?.url === "string" && f.url)
      .map((f: any): { url: string; height: number; size: number | null; thumbnail: string | null } => ({ url: f.url, height: Number(f.height) || 0, size: Number(f.size) || null, thumbnail: typeof f.thumbnail === "string" ? f.thumbnail : null }));
    const file = pickBySize(files, limit);
    if (!file) {
      reject(stats, REASON.noVideo);
      return [];
    }
    const pageUrl = typeof hit.pageURL === "string" ? hit.pageURL : `https://pixabay.com/videos/id-${hit.id}/`;
    const tags = typeof hit.tags === "string" ? hit.tags : "";
    return [
      stockSource("pixabay", {
        id: `pixabay:${hit.id}`,
        title: slugTitle(pageUrl) || tags || "Pixabay 영상",
        author: typeof hit.user === "string" ? hit.user : "Pixabay",
        pageUrl,
        mediaUrl: file.url,
        poster: file.thumbnail,
        duration,
        bytes: file.size,
        tags: tags || undefined,
        relevance: relevance - index * 0.03,
      }),
    ];
  });
}

/**
 * Mixkit 검색 페이지 HTML → 영상 목록.
 * 영상 페이지 링크(/free-stock-video/<제목>-<번호>/)에서 제목과 번호를, assets.mixkit.co의 mp4 주소에서 파일을 찾습니다.
 */
export function parseMixkit(html: string, relevance: number, limit = maxHeight(), stats?: SearchStats): SourceVideo[] {
  const items = new Map<string, string>();
  for (const match of html.matchAll(/\/free-stock-video\/([a-z0-9-]+?)-(\d{2,})\//g)) if (!items.has(match[2])) items.set(match[2], match[1]);
  const files = new Map<string, string>();
  for (const match of html.matchAll(/https:\/\/assets\.mixkit\.co\/videos\/(?:(\d+)\/\d+-\d+|preview\/mixkit-[a-z0-9-]+?-(\d+)-[a-z]+)\.mp4/g)) {
    const id = match[1] ?? match[2];
    if (!files.has(id)) files.set(id, match[0]);
  }
  const posters = new Map<string, string>();
  for (const match of html.matchAll(/https:\/\/assets\.mixkit\.co\/videos\/(\d+)\/[^"'\s]*thumb[^"'\s]*\.jpg/g)) if (!posters.has(match[1])) posters.set(match[1], match[0]);
  if (stats) stats.scanned += items.size;
  const quality = limit >= 1080 ? 1080 : 720;
  return [...items].map(([id, slug], index) => {
    const found = files.get(id);
    // 검색 페이지의 미리보기(360p)보다 큰 화질을 받습니다.
    const mediaUrl = found && /\/videos\/\d+\//.test(found) ? found.replace(/-\d+\.mp4$/, `-${quality}.mp4`) : (found ?? `https://assets.mixkit.co/videos/${id}/${id}-${quality}.mp4`);
    const pageUrl = `https://mixkit.co/free-stock-video/${slug}-${id}/`;
    const source = stockSource("mixkit", {
      id: `mixkit:${id}`,
      title: slug.replace(/-/g, " "),
      author: "Mixkit",
      pageUrl,
      mediaUrl,
      poster: posters.get(id) ?? null,
      duration: null,
      bytes: null,
      relevance: relevance - index * 0.03,
    });
    // 큰 화질이 없으면 찾은 미리보기 파일을 프록시로 받습니다.
    if (found && found !== mediaUrl) source.fallbackUrl = `${proxyBase()}/api/media?url=${encodeURIComponent(found)}`;
    return source;
  });
}

/** 스톡 사이트는 영어 검색이 정확하므로 영어 이름 위주로 (+ 특징 키워드 하나) */
export function stockQueries(topic: TopicInfo, hints: string[]): string[] {
  const english = topic.englishLabel ?? (HANGUL.test(topic.query) ? null : topic.query);
  const name = english ?? topic.label ?? topic.query;
  const list = [name];
  if (hints[0]) list.push(`${name} ${hints[0]}`);
  return [...new Set(list.map(q => q.trim()).filter(Boolean))];
}

/** 서버에도 키가 없다고 답한 출처 — 같은 세션에서 다시 묻지 않습니다(주제·검색어마다 헛요청을 보내지 않게). */
const missingServerKey = new Set<StockProvider>();

async function fetchStock(provider: StockProvider, q: string, key: string, signal?: AbortSignal): Promise<any> {
  if (!key && missingServerKey.has(provider)) throw new Error("API 키 필요");
  const asText = provider === "mixkit";
  const read = async (response: Response) => {
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `응답 오류 ${response.status}`);
    return asText ? response.text() : response.json();
  };
  // 내 키가 있으면 브라우저에서 바로 부르고(두 API 모두 CORS 허용), 막히면 프록시로 다시 시도합니다.
  if (key && provider !== "mixkit") {
    const direct = stockRequest(provider, q, key);
    try {
      if (direct) return await read(await fetch(direct.url, { headers: direct.headers, signal }));
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  const headers: Record<string, string> = key ? { "X-Api-Key": key } : {};
  const response = await fetch(`${proxyBase()}/api/stock?${new URLSearchParams({ provider, q })}`, { headers, signal });
  if (response.status === 501 && !key) missingServerKey.add(provider);
  return read(response);
}

const PARSERS: Record<StockProvider, (data: any, relevance: number, limit: number, stats?: SearchStats) => SourceVideo[]> = {
  pexels: parsePexels,
  pixabay: parsePixabay,
  mixkit: (html, relevance, limit, stats) => parseMixkit(typeof html === "string" ? html : "", relevance, limit, stats),
};

/** 한 스톡 사이트에서 주제 영상을 찾습니다. 검색어마다 실패해도 나머지 결과는 씁니다. */
export async function searchStock(provider: StockProvider, topic: TopicInfo, hints: string[], keys: StockKeys, signal?: AbortSignal, stats?: SearchStats): Promise<SourceVideo[]> {
  const key = provider === "mixkit" ? "" : keys[provider].trim();
  let queries = stockQueries(topic, hints);
  if (provider === "mixkit") queries = queries.filter(q => /[a-z]/i.test(q));
  if (!queries.length) return [];
  const results = await Promise.allSettled(queries.map(q => fetchStock(provider, q, key, signal)));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (results.every(r => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  const unique = new Map<string, SourceVideo>();
  results.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    // 스톡 영상은 주제와 느슨하게 관련된 경우가 많아 YouTube·Reddit보다 관련도를 낮게(Internet Archive와 비슷하게) 둡니다.
    for (const source of PARSERS[provider](result.value, 1.6 - i * 0.1, maxHeight(), stats)) if (!unique.has(source.id)) unique.set(source.id, source);
  });
  return [...unique.values()];
}
