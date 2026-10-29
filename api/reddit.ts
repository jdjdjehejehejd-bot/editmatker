// GET /api/reddit?q=검색어 — 브라우저에서 Reddit을 직접 못 부를 때 쓰는 검색 프록시

import { json, searchReddit } from "./_reddit";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const limit = Math.min(25, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  if (!q) return json(400, { error: "검색어가 비어 있어요." });
  try {
    const upstream = await searchReddit(q, limit);
    if (!upstream.ok) return json(502, { error: `Reddit 응답 오류 (${upstream.status})` });
    return json(200, await upstream.json(), { "Cache-Control": "public, s-maxage=600" });
  } catch {
    return json(502, { error: "Reddit에 연결하지 못했어요." });
  }
}
