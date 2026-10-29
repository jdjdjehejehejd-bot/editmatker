// Vercel 함수(api/)는 api 폴더에 테스트 파일을 두면 함수로 배포되므로 여기서 시험합니다.
import { afterEach, describe, expect, it, vi } from "vitest";
import media from "../../api/media";
import reddit from "../../api/reddit";
import { isRedditMediaUrl } from "../../api/_reddit";

afterEach(() => vi.unstubAllGlobals());

describe("Vercel 프록시", () => {
  it("v.redd.it 주소만 영상 프록시를 허용한다", async () => {
    expect(isRedditMediaUrl("https://v.redd.it/abc/DASH_480.mp4?source=fallback")).toBe(true);
    expect(isRedditMediaUrl("http://v.redd.it/abc")).toBe(false);
    expect(isRedditMediaUrl("https://v.redd.it.evil.example/abc")).toBe(false);
    expect(isRedditMediaUrl("https://example.com/a.mp4")).toBe(false);
    const response = await media(new Request("https://app.test/api/media?url=https%3A%2F%2Fexample.com%2Fa.mp4"));
    expect(response.status).toBe(400);
  });

  it("영상을 스트리밍으로 그대로 넘긴다", async () => {
    const fetchMock = vi.fn(async () => new Response("VIDEO", { headers: { "content-type": "video/mp4", "content-length": "5" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await media(new Request(`https://app.test/api/media?url=${encodeURIComponent("https://v.redd.it/abc/DASH_480.mp4")}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await response.text()).toBe("VIDEO");
    expect(fetchMock).toHaveBeenCalledWith("https://v.redd.it/abc/DASH_480.mp4", expect.anything());
  });

  it("Reddit 검색을 대신 불러 준다", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ data: { children: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await reddit(new Request("https://app.test/api/reddit?q=cats"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { children: [] } });
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://www.reddit.com/search.json?q=cats");
    expect((await reddit(new Request("https://app.test/api/reddit?q="))).status).toBe(400);
  });
});
