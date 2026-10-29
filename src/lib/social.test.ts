import { describe, expect, it } from "vitest";
import { parseRedditSearch, parseYouTubeSearch, socialQuery, youtubeId } from "./social";
import { rankSources, type TopicInfo } from "./sources";

const helper = "http://localhost:8787";
const topic: TopicInfo = { query: "손흥민", label: "손흥민", englishLabel: "Son Heung-min", description: null, commonsCategory: null, wikidataVideos: [] };

describe("parseYouTubeSearch", () => {
  it("도우미 주소를 거치는 영상 목록으로 바꾸고 라이브·너무 긴 영상은 뺀다", () => {
    const sources = parseYouTubeSearch(
      {
        entries: [
          { id: "abc123", title: "손흥민 골 모음", channel: "SPOTV", duration: 300, thumbnail: "https://i.ytimg.com/a.jpg" },
          { id: "live1", title: "라이브", live: true },
          { id: "long1", title: "풀경기", duration: 6000 },
        ],
      },
      helper
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "youtube:abc123",
      provider: "YouTube",
      author: "SPOTV",
      reusable: false,
      pageUrl: "https://www.youtube.com/watch?v=abc123",
      mediaUrl: "http://localhost:8787/api/media?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc123",
    });
  });
});

describe("parseRedditSearch", () => {
  const data = {
    data: {
      children: [
        { data: { name: "t3_a", title: "Amazing goal", author: "fan", subreddit: "soccer", permalink: "/r/soccer/comments/a/x/", is_video: true, secure_media: { reddit_video: { fallback_url: "https://v.redd.it/a/DASH_480.mp4", duration: 25 } } } },
        { data: { name: "t3_b", title: "NSFW", over_18: true, permalink: "/r/x/b/", is_video: true, secure_media: { reddit_video: { fallback_url: "https://v.redd.it/b.mp4", duration: 10 } } } },
        { data: { name: "t3_c", title: "Shared highlight", subreddit: "soccer", permalink: "/r/soccer/c/", url_overridden_by_dest: "https://youtu.be/xyz789" } },
        { data: { name: "t3_d", title: "Text post", permalink: "/r/soccer/d/" } },
      ],
    },
  };

  it("도우미가 있으면 Reddit 영상과 공유된 YouTube 링크를 모두 도우미로 받는다", () => {
    const sources = parseRedditSearch(data, helper);
    expect(sources.map(s => s.id)).toEqual(["reddit:t3_a", "youtube:xyz789"]);
    expect(sources[0].mediaUrl).toBe(`${helper}/api/media?url=${encodeURIComponent("https://www.reddit.com/r/soccer/comments/a/x/")}`);
    expect(sources[0].author).toBe("u/fan · r/soccer");
  });

  it("도우미가 없으면 Reddit 영상의 fallback 파일만 쓴다", () => {
    const sources = parseRedditSearch(data, null);
    expect(sources.map(s => s.id)).toEqual(["reddit:t3_a"]);
    expect(sources[0].mediaUrl).toBe("https://v.redd.it/a/DASH_480.mp4");
    expect(sources[0].fallbackUrl).toBe(`https://editmatker.vercel.app/api/media?url=${encodeURIComponent("https://v.redd.it/a/DASH_480.mp4")}`);
  });
});

describe("검색 보조", () => {
  it("YouTube 주소에서 영상 ID를 뽑는다", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=abc&t=10")).toBe("abc");
    expect(youtubeId("https://youtu.be/xyz")).toBe("xyz");
    expect(youtubeId("https://youtube.com/shorts/s1")).toBe("s1");
    expect(youtubeId("https://example.com/watch?v=abc")).toBeNull();
  });

  it("YouTube는 입력한 언어로, Reddit은 영어 이름으로 검색한다", () => {
    expect(socialQuery(topic, ["goal"], false)).toBe("손흥민 goal");
    expect(socialQuery(topic, ["goal"], true)).toBe("Son Heung-min goal");
  });

  it("YouTube·Reddit 영상이 Commons보다 앞에 온다", () => {
    const yt = parseYouTubeSearch({ entries: [{ id: "a", title: "손흥민 하이라이트", duration: 120 }] }, helper);
    const commons = { ...yt[0], id: "commons:1", provider: "Wikimedia Commons" as const, relevance: 3, title: "Son Heung-min 2019" };
    expect(rankSources([commons, ...yt], topic)[0].provider).toBe("YouTube");
  });
});
