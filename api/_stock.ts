// Pexels·Pixabay·Mixkit 검색·영상 프록시에서 함께 쓰는 도우미. 파일 이름이 _로 시작하면 Vercel이 별도 함수로 배포하지 않습니다.

export type StockProvider = "pexels" | "pixabay" | "mixkit";

const MEDIA_HOSTS = new Set(["videos.pexels.com", "player.vimeo.com", "cdn.pixabay.com", "assets.mixkit.co"]);

/** 프록시로 받아 줄 수 있는 스톡 영상 주소인지 */
export function isStockMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && MEDIA_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 프록시로 받아 줄 수 있는 Internet Archive 파일 주소인지 (https://archive.org/download/...) */
export function isArchiveMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "archive.org" && url.pathname.startsWith("/download/") && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Mixkit 검색 주소의 경로 조각 ("Tokyo Tower" → "tokyo-tower"). 라틴 문자가 없으면 null */
export function mixkitSlug(q: string): string | null {
  const slug = q
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/**
 * 출처별 검색 요청. key는 Pexels·Pixabay API 키(Mixkit은 필요 없음).
 * 응답은 그대로 돌려주고, 해석은 브라우저(src/lib/stock.ts)에서 합니다.
 */
export function stockRequest(provider: StockProvider, q: string, key: string | null, perPage = 20): { url: string; headers: Record<string, string> } | null {
  if (provider === "pexels") {
    if (!key) return null;
    return { url: `https://api.pexels.com/videos/search?${new URLSearchParams({ query: q, per_page: String(perPage), size: "medium" })}`, headers: { Authorization: key } };
  }
  if (provider === "pixabay") {
    if (!key) return null;
    const params = new URLSearchParams({ key, q: q.slice(0, 100), per_page: String(Math.max(3, perPage)), safesearch: "true" });
    if (/[ㄱ-힝]/.test(q)) params.set("lang", "ko");
    return { url: `https://pixabay.com/api/videos/?${params}`, headers: {} };
  }
  const slug = mixkitSlug(q);
  return slug ? { url: `https://mixkit.co/free-stock-video/${slug}/`, headers: { "User-Agent": "Mozilla/5.0 (compatible; editmatker/2.0)" } } : null;
}
