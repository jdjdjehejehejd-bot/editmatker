// YouTube·Reddit 검색. YouTube 영상은 로컬 도우미(helper/server.mjs)를 거쳐야 받을 수 있고,
// Reddit은 도우미가 없으면 브라우저에서 직접 검색해 소리 없는 영상 파일을 씁니다.

import { describeError, type SearchStats, type SourceVideo } from "./sources";
import { expandQueries, type SearchQuery, type TopicInfo } from "./topic";

export const DEFAULT_HELPER = "http://localhost:8787";
const MIN_DURATION = 3;
const MAX_DURATION = 25 * 60;

export interface HelperStatus {
  base: string | null;
  ytDlp: string | null;
}

const REMEMBER_KEY = "editmatker.helper";

export function servedLocally() {
  return typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
}

/** 예전에 도우미에 연결한 적이 있는지 (공개 사이트에서 localhost를 함부로 두드리면 브라우저가 권한을 묻습니다) */
export function rememberedHelper(): boolean {
  try {
    return servedLocally() || localStorage.getItem(REMEMBER_KEY) === "1";
  } catch {
    return servedLocally();
  }
}

/** 로컬 도우미가 켜져 있는지 확인합니다. 도우미가 이 페이지를 직접 띄운 경우도 처리합니다. */
export async function detectHelper(): Promise<HelperStatus> {
  const candidates = new Set<string>();
  if (servedLocally()) candidates.add(location.origin);
  candidates.add(DEFAULT_HELPER);
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      const data = await response.json();
      if (data?.ok) {
        try {
          localStorage.setItem(REMEMBER_KEY, "1");
        } catch {
          /* 저장 불가 */
        }
        return { base, ytDlp: typeof data.ytDlp === "string" ? data.ytDlp : null };
      }
    } catch {
      /* 다음 후보 */
    }
  }
  return { base: null, ytDlp: null };
}

export function helperMediaUrl(helper: string, pageUrl: string) {
  return `${helper}/api/media?url=${encodeURIComponent(pageUrl)}`;
}

function inRange(duration: number | null) {
  return duration === null || (duration >= MIN_DURATION && duration <= MAX_DURATION);
}

export function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1) || null;
    if (!/(^|\.)youtube\.com$/.test(parsed.hostname)) return null;
    if (parsed.pathname.startsWith("/shorts/")) return parsed.pathname.split("/")[2] || null;
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

function youtubeSource(id: string, title: string, channel: string, duration: number | null, poster: string | null, helper: string, relevance: number): SourceVideo {
  const pageUrl = `https://www.youtube.com/watch?v=${id}`;
  return {
    id: `youtube:${id}`,
    provider: "YouTube",
    title,
    author: channel || "채널 정보 없음",
    license: "YouTube 표준 라이선스",
    licenseUrl: "https://www.youtube.com/t/terms",
    reusable: false,
    pageUrl,
    mediaUrl: helperMediaUrl(helper, pageUrl),
    poster: poster ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration,
    bytes: null,
    relevance,
  };
}

/** 도우미의 /api/youtube/search 응답을 영상 목록으로 바꿉니다. */
export function parseYouTubeSearch(data: any, helper: string, offset = 0): SourceVideo[] {
  const entries: any[] = Array.isArray(data?.entries) ? data.entries : [];
  return entries.flatMap((e, i) => {
    if (typeof e?.id !== "string" || e.live) return [];
    const duration = Number(e.duration) || null;
    if (!inRange(duration)) return [];
    return [youtubeSource(e.id, String(e.title ?? "제목 없음").slice(0, 200), String(e.channel ?? ""), duration, e.thumbnail ?? null, helper, 4 + offset - i * 0.05)];
  });
}

/** Reddit search.json 응답에서 영상 게시물(Reddit 업로드 영상, YouTube 링크)을 고릅니다. */
export function parseRedditSearch(data: any, helper: string | null, offset = 0): SourceVideo[] {
  const posts: any[] = (data?.data?.children ?? []).map((child: any) => child?.data).filter(Boolean);
  const sources: SourceVideo[] = [];
  posts.forEach((post, i) => {
    if (post.over_18 || typeof post.permalink !== "string") return;
    const relevance = 3.9 + offset - i * 0.05;
    const title = String(post.title ?? "제목 없음").slice(0, 200);
    const video = post.secure_media?.reddit_video ?? post.media?.reddit_video;
    if (post.is_video && video) {
      const duration = Number(video.duration) || null;
      if (!inRange(duration)) return;
      const pageUrl = `https://www.reddit.com${post.permalink}`;
      // 도우미가 없으면 소리 없는 fallback 영상만 쓸 수 있습니다(배경음악으로 대체되므로 편집에는 지장 없음).
      const direct = typeof video.fallback_url === "string" ? video.fallback_url : null;
      const mediaUrl = helper ? helperMediaUrl(helper, pageUrl) : direct;
      if (!mediaUrl) return;
      sources.push({
        id: `reddit:${post.name ?? post.id}`,
        provider: "Reddit",
        title,
        author: `u/${post.author ?? "unknown"} · r/${post.subreddit ?? "?"}`,
        license: "Reddit 게시물",
        licenseUrl: null,
        reusable: false,
        pageUrl,
        mediaUrl,
        // 브라우저가 v.redd.it을 직접 못 받으면 같은 사이트의 /api/media 프록시로 다시 시도합니다.
        fallbackUrl: !helper && direct ? `${proxyBase()}/api/media?url=${encodeURIComponent(direct)}` : undefined,
        poster: post.preview?.images?.[0]?.source?.url ?? (String(post.thumbnail ?? "").startsWith("http") ? post.thumbnail : null),
        duration,
        bytes: null,
        relevance,
      });
      return;
    }
    // Reddit에서 공유된 YouTube 링크
    const id = helper ? youtubeId(String(post.url_overridden_by_dest ?? post.url ?? "")) : null;
    if (id && helper) sources.push(youtubeSource(id, title, `r/${post.subreddit ?? "?"}`, null, null, helper, relevance - 0.1));
  });
  return sources;
}

/** 여러 검색어 결과를 합칩니다. 일부만 실패하면 나머지 결과를 쓰고, 모두 실패하면 첫 오류를 냅니다. */
/** 넓힌 검색어일수록 관련도를 낮춥니다 (가중치 1 → 0, 0.6 → -0.8). */
function weightOffset(query: SearchQuery) {
  return (query.weight - 1) * 2;
}

async function searchAll(queries: SearchQuery[], search: (query: SearchQuery) => Promise<SourceVideo[]>, signal?: AbortSignal): Promise<SourceVideo[]> {
  const results = await Promise.allSettled(queries.map(search));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const ok = results.filter((r): r is PromiseFulfilledResult<SourceVideo[]> => r.status === "fulfilled");
  if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
  const unique = new Map<string, SourceVideo>();
  for (const source of ok.flatMap(r => r.value)) {
    const existing = unique.get(source.id);
    // 두 언어 검색에 모두 걸린 영상은 관련도가 높은 쪽을 남깁니다.
    if (!existing || existing.relevance < source.relevance) unique.set(source.id, source);
  }
  return [...unique.values()];
}

export async function searchYouTube(topic: TopicInfo, hints: string[], helper: string, signal?: AbortSignal): Promise<SourceVideo[]> {
  return searchAll(
    expandQueries(topic, hints),
    async query => {
      const response = await fetch(`${helper}/api/youtube/search?q=${encodeURIComponent(query.q)}&limit=${query.weight < 1 ? 6 : 12}`, { signal });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `YouTube 검색 실패 (${response.status})`);
      return parseYouTubeSearch(await response.json(), helper, weightOffset(query));
    },
    signal
  );
}

/** 배포된 웹앱의 /api 함수 주소. 로컬 개발(vite)에는 함수가 없으므로 배포 주소를 씁니다. */
export function proxyBase() {
  if (typeof location === "undefined" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return "https://editmatker.vercel.app";
  return location.origin;
}

async function fetchJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `응답 오류 ${response.status}`);
  return response.json();
}

/**
 * 도우미가 있으면 도우미로, 없으면 휴대폰 브라우저에서 Reddit을 직접 부르고(사용자 IP라 잘 막히지 않음),
 * 그것도 막히면 Vercel 함수 프록시를 거칩니다.
 */
export async function searchReddit(topic: TopicInfo, hints: string[], helper: string | null, signal?: AbortSignal, stats?: SearchStats): Promise<SourceVideo[]> {
  return searchAll(expandQueries(topic, hints), query => searchRedditOnce(query, helper, signal, stats), signal);
}

function countPosts(data: any) {
  return Array.isArray(data?.data?.children) ? data.data.children.length : 0;
}

async function searchRedditOnce(query: SearchQuery, helper: string | null, signal?: AbortSignal, stats?: SearchStats): Promise<SourceVideo[]> {
  const q = query.q;
  let data: unknown;
  if (helper) {
    data = await fetchJson(`${helper}/api/reddit/search?q=${encodeURIComponent(q)}&limit=50`, signal);
  } else {
    const params = new URLSearchParams({ q, sort: "relevance", t: "all", type: "link", limit: "50", raw_json: "1" });
    try {
      data = await fetchJson(`https://www.reddit.com/search.json?${params}`, signal);
    } catch (direct) {
      if (signal?.aborted) throw direct;
      try {
        data = await fetchJson(`${proxyBase()}/api/reddit?q=${encodeURIComponent(q)}&limit=50`, signal);
      } catch (proxy) {
        if (signal?.aborted) throw proxy;
        throw new Error(`직접: ${describeError(direct)} / 서버 경유: ${describeError(proxy)}`);
      }
    }
  }
  if (stats) stats.scanned += countPosts(data);
  return parseRedditSearch(data, helper, weightOffset(query));
}
