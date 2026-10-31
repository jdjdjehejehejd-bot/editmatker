// GET /api/media?url=https://v.redd.it/... — Reddit·스톡(Pexels·Pixabay·Mixkit)·Internet Archive 영상 파일을 같은 출처로 흘려보내는 프록시.
// 응답을 스트리밍하므로 Vercel 함수의 4.5MB 응답 제한을 받지 않습니다.

import { isRedditMediaUrl, json, REDDIT_MEDIA_HEADERS, redditVideoVariants } from "./_reddit";
import { isArchiveMediaUrl, isAudioMediaUrl, isStockMediaUrl } from "./_stock";

export const config = { runtime: "edge" };

const MAX_BYTES = 80 * 1024 * 1024;

export default async function handler(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url") ?? "";
  if (!isRedditMediaUrl(target) && !isStockMediaUrl(target) && !isArchiveMediaUrl(target) && !isAudioMediaUrl(target)) return json(400, { error: "지원하는 영상 주소만 받을 수 있어요." });
  try {
    // Reddit 영상은 브라우저처럼 요청하고, 막히면 다른 화질·이름(DASH/CMAF)으로 차례로 다시 시도합니다.
    const reddit = isRedditMediaUrl(target);
    const candidates = reddit ? redditVideoVariants(target) : [target];
    let upstream: Response | null = null;
    let lastStatus = 0;
    for (const url of candidates) {
      const response = await fetch(url, { headers: reddit ? REDDIT_MEDIA_HEADERS : { "User-Agent": "web:editmatker:2.0" } });
      if (response.ok && response.body) {
        upstream = response;
        break;
      }
      lastStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
    }
    if (!upstream || !upstream.body) return json(502, { error: `영상 응답 오류 (${lastStatus})` });
    const length = Number(upstream.headers.get("content-length"));
    if (length > MAX_BYTES) return json(413, { error: "영상이 너무 커요." });
    const headers: Record<string, string> = { "Content-Type": upstream.headers.get("content-type") ?? (isAudioMediaUrl(target) ? "audio/mpeg" : "video/mp4"), "Cache-Control": "public, s-maxage=86400" };
    if (length) headers["Content-Length"] = String(length);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return json(502, { error: "영상을 가져오지 못했어요." });
  }
}
