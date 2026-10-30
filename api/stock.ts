// GET /api/stock?provider=pexels|pixabay|mixkit&q=검색어 — 스톡 영상 검색 프록시.
// Pexels·Pixabay는 PEXELS_API_KEY / PIXABAY_API_KEY 환경 변수, 또는 브라우저가 보낸 X-Api-Key 헤더의 키를 씁니다.
// Mixkit은 API가 없어 검색 페이지 HTML을 그대로 돌려줍니다(브라우저에서는 CORS 때문에 직접 못 받음).

import { json } from "./_reddit";
import { stockRequest, type StockProvider } from "./_stock";

export const config = { runtime: "edge" };

const PROVIDERS: StockProvider[] = ["pexels", "pixabay", "mixkit"];

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") as StockProvider;
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!PROVIDERS.includes(provider)) return json(400, { error: "지원하지 않는 출처예요." });
  if (!q) return json(400, { error: "검색어가 비어 있어요." });
  const envKey = provider === "pexels" ? process.env.PEXELS_API_KEY : provider === "pixabay" ? process.env.PIXABAY_API_KEY : null;
  const key = request.headers.get("x-api-key")?.trim() || envKey || null;
  const target = stockRequest(provider, q, key);
  if (!target) return json(provider === "mixkit" ? 400 : 501, { error: provider === "mixkit" ? "영어 검색어가 필요해요." : "API 키 필요" });
  try {
    const upstream = await fetch(target.url, { headers: target.headers });
    if (upstream.status === 404 && provider === "mixkit") return new Response("", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (!upstream.ok) return json(502, { error: `응답 오류 ${upstream.status}` });
    const cache = { "Cache-Control": "public, s-maxage=3600" };
    if (provider === "mixkit") return new Response(await upstream.text(), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...cache } });
    return json(200, await upstream.json(), cache);
  } catch {
    return json(502, { error: "검색하지 못했어요." });
  }
}
