// YouTube·Reddit 검색. YouTube 영상은 로컬 도우미(helper/server.mjs)를 거쳐야 받을 수 있고,
// Reddit은 도우미가 없으면 브라우저에서 직접 검색해 소리 없는 영상 파일을 씁니다.

import type { SourceVideo, TopicInfo } from "./sources";

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
export function parseYouTubeSearch(data: any, helper: string): SourceVideo[] {
  const entries: any[] = Array.isArray(data?.entries) ? data.entries : [];
  return entries.flatMap((e, i) => {
    if (typeof e?.id !== "string" || e.live) return [];
    const duration = Number(e.duration) || null;
    if (!inRange(duration)) return [];
    return [youtubeSource(e.id, String(e.title ?? "제목 없음").slice(0, 200), String(e.channel ?? ""), duration, e.thumbnail ?? null, helper, 4 - i * 0.05)];
  });
}

/** Reddit search.json 응답에서 영상 게시물(Reddit 업로드 영상, YouTube 링크)을 고릅니다. */
export function parseRedditSearch(data: any, helper: string | null): SourceVideo[] {
  const posts: any[] = (data?.data?.children ?? []).map((child: any) => child?.data).filter(Boolean);
  const sources: SourceVideo[] = [];
  posts.forEach((post, i) => {
    if (post.over_18 || typeof post.permalink !== "string") return;
    const relevance = 3.9 - i * 0.05;
    const title = String(post.title ?? "제목 없음").slice(0, 200);
    const video = post.secure_media?.reddit_video ?? post.media?.reddit_video;
    if (post.is_video && video) {
      const duration = Number(video.duration) || null;
      if (!inRange(duration)) return;
      const pageUrl = `https://www.reddit.com${post.permalink}`;
      // 도우미가 없으면 소리 없는 fallback 영상만 쓸 수 있습니다(배경음악으로 대체되므로 편집에는 지장 없음).
      const mediaUrl = helper ? helperMediaUrl(helper, pageUrl) : typeof video.fallback_url === "string" ? video.fallback_url : null;
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

export function socialQuery(topic: TopicInfo, hints: string[], preferEnglish: boolean) {
  const name = preferEnglish ? topic.englishLabel ?? topic.query : topic.query;
  return [name, ...hints].join(" ").trim();
}

export async function searchYouTube(topic: TopicInfo, hints: string[], helper: string, signal?: AbortSignal): Promise<SourceVideo[]> {
  const url = `${helper}/api/youtube/search?q=${encodeURIComponent(socialQuery(topic, hints, false))}&limit=15`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `YouTube 검색 실패 (${response.status})`);
  return parseYouTubeSearch(await response.json(), helper);
}

export async function searchReddit(topic: TopicInfo, hints: string[], helper: string | null, signal?: AbortSignal): Promise<SourceVideo[]> {
  const q = socialQuery(topic, hints, true);
  const url = helper
    ? `${helper}/api/reddit/search?q=${encodeURIComponent(q)}&limit=25`
    : `https://www.reddit.com/search.json?${new URLSearchParams({ q, sort: "relevance", t: "all", type: "link", limit: "25", raw_json: "1" })}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Reddit 검색 실패 (${response.status})`);
  return parseRedditSearch(await response.json(), helper);
}
