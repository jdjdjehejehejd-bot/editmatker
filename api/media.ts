// GET /api/media?url=https://v.redd.it/... — Reddit·스톡(Pexels·Pixabay·Mixkit) 영상 파일을 같은 출처로 흘려보내는 프록시.
// 응답을 스트리밍하므로 Vercel 함수의 4.5MB 응답 제한을 받지 않습니다.

import { isRedditMediaUrl, json } from "./_reddit";
import { isStockMediaUrl } from "./_stock";

export const config = { runtime: "edge" };

const MAX_BYTES = 80 * 1024 * 1024;

export default async function handler(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url") ?? "";
  if (!isRedditMediaUrl(target) && !isStockMediaUrl(target)) return json(400, { error: "지원하는 영상 주소만 받을 수 있어요." });
  try {
    const upstream = await fetch(target, { headers: { "User-Agent": "web:editmatker:2.0" } });
    if (!upstream.ok || !upstream.body) return json(502, { error: `영상 응답 오류 (${upstream.status})` });
    const length = Number(upstream.headers.get("content-length"));
    if (length > MAX_BYTES) return json(413, { error: "영상이 너무 커요." });
    const headers: Record<string, string> = { "Content-Type": upstream.headers.get("content-type") ?? "video/mp4", "Cache-Control": "public, s-maxage=86400" };
    if (length) headers["Content-Length"] = String(length);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return json(502, { error: "영상을 가져오지 못했어요." });
  }
}
