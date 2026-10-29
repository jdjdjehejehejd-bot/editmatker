// Vercel 함수에서 함께 쓰는 Reddit 도우미. 파일 이름이 _로 시작하면 Vercel이 별도 함수로 배포하지 않습니다.

const USER_AGENT = "web:editmatker:2.0 (by /u/editmatker)";

/** 프록시로 받아 줄 수 있는 Reddit 영상 주소인지 (https://v.redd.it/...) */
export function isRedditMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "v.redd.it" && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function redditSearchParams(q: string, limit: number) {
  return new URLSearchParams({ q, sort: "relevance", t: "all", type: "link", limit: String(limit), raw_json: "1" });
}

let token: { value: string; expiresAt: number } | null = null;

/**
 * REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 환경 변수가 있으면 앱 전용 OAuth 토큰을 씁니다.
 * 서버 IP에서 보내는 익명 요청은 Reddit이 막는 경우가 있어서입니다.
 */
async function oauthToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (typeof data?.access_token !== "string") return null;
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

export async function searchReddit(q: string, limit: number): Promise<Response> {
  const bearer = await oauthToken().catch(() => null);
  const url = bearer ? `https://oauth.reddit.com/search?${redditSearchParams(q, limit)}` : `https://www.reddit.com/search.json?${redditSearchParams(q, limit)}`;
  return fetch(url, { headers: { "User-Agent": USER_AGENT, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
}

/**
 * Reddit이 서버 IP를 막으면 PullPush(공개 Reddit 아카이브)에서 같은 검색을 하고,
 * Reddit 검색 응답과 같은 모양({ data: { children: [{ data }] } })으로 바꿉니다.
 */
export async function searchPullPush(q: string, limit: number): Promise<unknown> {
  const url = `https://api.pullpush.io/reddit/search/submission/?${new URLSearchParams({ q, size: String(Math.min(100, limit * 2)) })}`;
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`PullPush 응답 오류 (${response.status})`);
  return toListing(await response.json());
}

export function toListing(data: any) {
  const posts: any[] = Array.isArray(data?.data) ? data.data : [];
  return { data: { children: posts.map(post => ({ data: post })) } };
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
}
