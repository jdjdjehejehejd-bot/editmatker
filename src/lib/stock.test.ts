import { describe, expect, it } from "vitest";
import { isStockMediaUrl, mixkitSlug, stockRequest } from "../../api/_stock";
import { loadStockKeys, parseMixkit, parsePexels, parsePixabay, pickBySize, saveStockKeys, slugTitle, stockQueries } from "./stock";
import type { TopicInfo } from "./topic";

const topic = (query: string, englishLabel: string | null = null): TopicInfo => ({ query, label: query, englishLabel, description: null, commonsCategory: null, wikidataVideos: [], aliases: [], related: [] });

describe("Pexels", () => {
  const data = {
    videos: [
      {
        id: 123,
        url: "https://www.pexels.com/video/tokyo-tower-at-night-123/",
        image: "https://images.pexels.com/videos/123/poster.jpg",
        duration: 18,
        user: { name: "Kim" },
        video_files: [
          { link: "https://videos.pexels.com/video-files/123/uhd.mp4", file_type: "video/mp4", height: 2160 },
          { link: "https://videos.pexels.com/video-files/123/hd.mp4", file_type: "video/mp4", height: 1080 },
          { link: "https://videos.pexels.com/video-files/123/sd.mp4", file_type: "video/mp4", height: 540 },
        ],
      },
      { id: 9, url: "https://www.pexels.com/video/too-long-9/", duration: 5000, video_files: [{ link: "https://videos.pexels.com/x.mp4", file_type: "video/mp4", height: 720 }] },
    ],
  };

  it("주제 제목·화질을 고르고 재사용 가능한 라이선스로 표시", () => {
    const stats = { scanned: 0 };
    const [video, ...rest] = parsePexels(data, 1, 1080, stats);
    expect(rest).toEqual([]);
    expect(video).toMatchObject({ id: "pexels:123", provider: "Pexels", title: "tokyo tower at night", author: "Kim", mediaUrl: "https://videos.pexels.com/video-files/123/hd.mp4", duration: 18, reusable: true, license: "Pexels License" });
    expect(video.fallbackUrl).toContain("/api/media?url=");
    expect(stats.scanned).toBe(2);
    expect(parsePexels(data, 1, 720)[0].mediaUrl).toContain("sd.mp4");
  });
});

describe("Pixabay", () => {
  it("태그·크기를 함께 읽음", () => {
    const [video] = parsePixabay(
      {
        hits: [
          {
            id: 77,
            pageURL: "https://pixabay.com/videos/seoul-city-night-77/",
            tags: "seoul, city, night",
            duration: 25,
            user: "lee",
            videos: { large: { url: "https://cdn.pixabay.com/video/l.mp4", height: 1080, size: 9000, thumbnail: "https://cdn.pixabay.com/l.jpg" }, medium: { url: "https://cdn.pixabay.com/video/m.mp4", height: 720, size: 4000 }, small: { url: "", height: 540 } },
          },
        ],
      },
      1,
      720
    );
    expect(video).toMatchObject({ id: "pixabay:77", provider: "Pixabay", title: "seoul city night", tags: "seoul, city, night", mediaUrl: "https://cdn.pixabay.com/video/m.mp4", bytes: 4000 });
  });
});

describe("Mixkit", () => {
  it("검색 페이지에서 영상 번호·제목·파일을 찾고 큰 화질로 바꿈", () => {
    const html = `
      <a href="/free-stock-video/tokyo-street-crossing-4401/"><video src="https://assets.mixkit.co/videos/4401/4401-360.mp4" poster="https://assets.mixkit.co/videos/4401/4401-thumb-360-0.jpg"></video>Tokyo street crossing</a>
      <a href="/free-stock-video/tokyo-street-crossing-4401/">again</a>
      <a href="/free-stock-video/old-tokyo-train-39/"><video src="https://assets.mixkit.co/videos/preview/mixkit-old-tokyo-train-39-large.mp4"></video></a>
      <a href="/free-stock-video/discover/tokyo/">category</a>`;
    const videos = parseMixkit(html, 1, 720);
    expect(videos.map(v => v.id)).toEqual(["mixkit:4401", "mixkit:39"]);
    expect(videos[0]).toMatchObject({ title: "tokyo street crossing", mediaUrl: "https://assets.mixkit.co/videos/4401/4401-720.mp4", poster: "https://assets.mixkit.co/videos/4401/4401-thumb-360-0.jpg", license: "Mixkit Free License" });
    expect(decodeURIComponent(videos[0].fallbackUrl!)).toContain("4401-360.mp4");
    expect(videos[1].mediaUrl).toBe("https://assets.mixkit.co/videos/preview/mixkit-old-tokyo-train-39-large.mp4");
    expect(parseMixkit("<html>no results</html>", 1)).toEqual([]);
  });
});

describe("스톡 도우미", () => {
  it("검색어는 영어 이름 위주", () => {
    expect(stockQueries(topic("손흥민", "Son Heung-min"), ["goal"])).toEqual(["Son Heung-min", "Son Heung-min goal"]);
    expect(stockQueries(topic("Tokyo"), [])).toEqual(["Tokyo"]);
    expect(stockQueries(topic("서울"), [])).toEqual(["서울"]);
  });

  it("화질 고르기와 제목 만들기", () => {
    expect(pickBySize([{ height: 2160 }, { height: 1440 }], 1080)).toEqual({ height: 1440 });
    expect(pickBySize([], 1080)).toBeNull();
    expect(slugTitle("https://www.pexels.com/video/a-b-c-12/")).toBe("a b c");
  });

  it("API 키를 저장하고 불러옴", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    saveStockKeys({ pexels: " abc ", pixabay: "" }, storage);
    expect(loadStockKeys(storage)).toEqual({ pexels: "abc", pixabay: "" });
    expect(loadStockKeys({ getItem: () => "{broken" })).toEqual({ pexels: "", pixabay: "" });
  });
});

describe("스톡 프록시", () => {
  it("허용한 영상 서버만 프록시", () => {
    expect(isStockMediaUrl("https://videos.pexels.com/video-files/1/a.mp4")).toBe(true);
    expect(isStockMediaUrl("https://cdn.pixabay.com/video/a.mp4")).toBe(true);
    expect(isStockMediaUrl("https://assets.mixkit.co/videos/1/1-720.mp4")).toBe(true);
    expect(isStockMediaUrl("https://assets.mixkit.co.evil.example/a.mp4")).toBe(false);
    expect(isStockMediaUrl("http://cdn.pixabay.com/a.mp4")).toBe(false);
  });

  it("출처별 검색 주소", () => {
    expect(stockRequest("pexels", "tokyo", null)).toBeNull();
    expect(stockRequest("pexels", "tokyo", "k")).toMatchObject({ headers: { Authorization: "k" } });
    expect(stockRequest("pixabay", "서울", "k")!.url).toContain("lang=ko");
    expect(stockRequest("mixkit", "Tokyo Tower!", null)!.url).toBe("https://mixkit.co/free-stock-video/tokyo-tower/");
    expect(mixkitSlug("서울")).toBeNull();
  });
});

describe("Internet Archive 프록시", () => {
  it("archive.org 다운로드 주소만 허용", async () => {
    const { isArchiveMediaUrl } = await import("../../api/_stock");
    expect(isArchiveMediaUrl("https://archive.org/download/film1/film1.mp4")).toBe(true);
    expect(isArchiveMediaUrl("https://archive.org/details/film1")).toBe(false);
    expect(isArchiveMediaUrl("https://archive.org.evil.example/download/a.mp4")).toBe(false);
  });
});
