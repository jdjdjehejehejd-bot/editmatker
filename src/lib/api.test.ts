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

  it("Reddit이 막으면 PullPush 결과를 Reddit 모양으로 바꿔 돌려준다", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("reddit.com") ? new Response("blocked", { status: 403 }) : Response.json({ data: [{ id: "x1", title: "Cat", is_video: true }] })
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await reddit(new Request("https://app.test/api/reddit?q=cats"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-editmatker-source")).toBe("pullpush");
    expect(await response.json()).toEqual({ data: { children: [{ data: { id: "x1", title: "Cat", is_video: true } }] } });
    expect(String(fetchMock.mock.calls[1][0])).toContain("https://api.pullpush.io/reddit/search/submission/?q=cats");
  });

  it("둘 다 실패하면 이유를 함께 알려 준다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    const response = await reddit(new Request("https://app.test/api/reddit?q=cats"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("Reddit 응답 오류 403, PullPush 응답 오류 (403)");
  });
});

describe("Reddit 영상 주소 후보", () => {
  it("원래 주소 → 쿼리 없이 → 낮은 화질 → CMAF 이름 순서", async () => {
    const { redditVideoVariants } = await import("../../api/_reddit");
    const list = redditVideoVariants("https://v.redd.it/abc123/DASH_720.mp4?source=fallback");
    expect(list[0]).toBe("https://v.redd.it/abc123/DASH_720.mp4?source=fallback");
    expect(list[1]).toBe("https://v.redd.it/abc123/DASH_720.mp4");
    expect(list).toContain("https://v.redd.it/abc123/DASH_480.mp4");
    expect(list).toContain("https://v.redd.it/abc123/CMAF_720.mp4");
    expect(list.length).toBeLessThanOrEqual(8);
    expect(list.every(url => url.startsWith("https://v.redd.it/abc123/"))).toBe(true);
    // 더 높은 화질은 만들지 않음
    expect(redditVideoVariants("https://v.redd.it/x/DASH_360.mp4").some(url => url.includes("_720"))).toBe(false);
    // 다른 주소는 그대로
    expect(redditVideoVariants("https://v.redd.it/x/HLSPlaylist.m3u8")).toEqual(["https://v.redd.it/x/HLSPlaylist.m3u8"]);
  });
});
