import { describe, expect, it } from "vitest";
import { buildArchiveQuery, buildCommonsQueries, normalizeLicense, parseCommonsPage, pickArchiveFile, rankSources, resolveLicense, type TopicInfo } from "./sources";

const canPlayWebm = (mime: string) => mime.includes("webm");

describe("normalizeLicense", () => {
  it("허용 라이선스를 정규화한다", () => {
    expect(normalizeLicense("CC BY-SA 4.0")?.label).toBe("CC BY-SA 4.0");
    expect(normalizeLicense("CC BY 3.0")?.licenseUrl).toBe("https://creativecommons.org/licenses/by/3.0/");
    expect(normalizeLicense("Public domain")?.label).toBe("Public domain");
    expect(normalizeLicense("CC0")?.label).toBe("CC0 1.0");
    expect(normalizeLicense("", "http://creativecommons.org/licenses/by-sa/2.0/")?.label).toBe("CC BY-SA 2.0");
    expect(normalizeLicense("", "http://creativecommons.org/publicdomain/mark/1.0/")?.label).toBe("Public domain");
  });

  it("비영리·변경금지·불명확한 라이선스는 거부한다", () => {
    expect(normalizeLicense("CC BY-NC 4.0")).toBeNull();
    expect(normalizeLicense("CC BY-ND 4.0")).toBeNull();
    expect(normalizeLicense("", "http://creativecommons.org/licenses/by-nc-sa/3.0/")).toBeNull();
    expect(normalizeLicense("GFDL")).toBeNull();
    expect(normalizeLicense("CC BY")).toBeNull();
  });
});

describe("resolveLicense", () => {
  it("재사용 모드는 허용 목록만, 전체 모드는 무엇이든 통과시킨다", () => {
    expect(resolveLicense("CC BY-ND 4.0", null, "reusable")).toBeNull();
    expect(resolveLicense("CC BY-ND 4.0", null, "any")).toEqual({ label: "CC BY-ND 4.0", licenseUrl: null, reusable: false });
    expect(resolveLicense("", null, "any")?.label).toBe("라이선스 미표기");
    expect(resolveLicense("", "https://creativecommons.org/licenses/by-nc/3.0/", "any")?.label).toBe("CC BY-NC 3.0");
    expect(resolveLicense("CC0", null, "any")?.reusable).toBe(true);
  });
});

describe("parseCommonsPage", () => {
  const page = {
    pageid: 42,
    title: "File:Apollo_11_launch.webm",
    index: 1,
    videoinfo: [
      {
        mediatype: "VIDEO",
        duration: 120,
        size: 300_000_000,
        mime: "video/webm",
        url: "https://upload.wikimedia.org/original.webm",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Apollo_11_launch.webm",
        thumburl: "https://upload.wikimedia.org/thumb.jpg",
        extmetadata: { LicenseShortName: { value: "Public domain" }, Artist: { value: "<a href='x'>NASA</a>" } },
        derivatives: [
          { src: "https://upload.wikimedia.org/1080p.webm", type: 'video/webm; codecs="vp9"', height: 1080, bandwidth: 4_000_000 },
          { src: "https://upload.wikimedia.org/480p.webm", type: 'video/webm; codecs="vp9"', height: 480, bandwidth: 1_000_000 },
          { src: "https://upload.wikimedia.org/480p.mp4", type: "video/mp4", height: 480, bandwidth: 900_000 },
        ],
      },
    ],
  };

  it("재생 가능한 480p 변환본과 메타데이터를 고른다", () => {
    const source = parseCommonsPage(page, 1, "reusable", canPlayWebm)!;
    expect(source.mediaUrl).toBe("https://upload.wikimedia.org/480p.webm");
    expect(source.author).toBe("NASA");
    expect(source.title).toBe("Apollo 11 launch");
    expect(source.bytes).toBe(15_000_000);
  });

  it("다른 호스트나 허용되지 않은 라이선스는 거부한다", () => {
    const badHost = structuredClone(page);
    badHost.videoinfo[0].derivatives = [{ src: "https://evil.example/a.webm", type: "video/webm", height: 480, bandwidth: 1 }];
    expect(parseCommonsPage(badHost, 1, "any", canPlayWebm)).toBeNull();
    const nc = structuredClone(page);
    nc.videoinfo[0].extmetadata.LicenseShortName.value = "CC BY-NC 2.0";
    expect(parseCommonsPage(nc, 1, "reusable", canPlayWebm)).toBeNull();
  });

  it("모든 공개 영상 모드에서는 NC 영상도 표시해서 쓴다", () => {
    const nc = structuredClone(page);
    nc.videoinfo[0].extmetadata.LicenseShortName.value = "CC BY-NC 2.0";
    const source = parseCommonsPage(nc, 1, "any", canPlayWebm)!;
    expect(source.license).toBe("CC BY-NC 2.0");
    expect(source.reusable).toBe(false);
    expect(parseCommonsPage(page, 1, "any", canPlayWebm)!.reusable).toBe(true);
  });
});

describe("검색 보조", () => {
  const topic: TopicInfo = { query: "아폴로 11호", label: "아폴로 11호", englishLabel: "Apollo 11", description: null, commonsCategory: "Apollo 11", wikidataVideos: [] };

  it("분류·영어 이름·힌트로 검색어를 만든다", () => {
    const queries = buildCommonsQueries(topic, ["launch"]);
    expect(queries[0]).toBe('filetype:video incategory:"Apollo 11"');
    expect(queries).toContain('filetype:video "Apollo 11" launch');
  });

  it("Internet Archive 검색은 모드에 따라 라이선스 조건을 붙인다", () => {
    expect(buildArchiveQuery(topic, [], "reusable")).toContain("licenseurl:");
    expect(buildArchiveQuery(topic, [], "any")).not.toContain("licenseurl:");
    expect(buildArchiveQuery(topic, [], "any")).toContain("NOT collection:(inlibrary");
  });

  it("작은 mp4 파일을 고른다", () => {
    const file = pickArchiveFile([
      { name: "a.ogv", size: "100" },
      { name: "big.mp4", size: String(500 * 1024 * 1024) },
      { name: "a_512kb.mp4", size: "30000000", length: "02:30" },
      { name: "a.mp4", size: "60000000", length: "150" },
    ]);
    expect(file).toEqual({ name: "a_512kb.mp4", bytes: 30_000_000, duration: 150 });
  });

  it("제목에 주제가 들어간 영상을 우선한다", () => {
    const base = { provider: "Wikimedia Commons" as const, author: "", license: "CC0 1.0", licenseUrl: null, reusable: true, pageUrl: "", mediaUrl: "", poster: null, bytes: null };
    const ranked = rankSources(
      [
        { ...base, id: "a", title: "Random rocket", duration: 60, relevance: 1 },
        { ...base, id: "b", title: "Apollo 11 liftoff", duration: 60, relevance: 0.9 },
      ],
      topic
    );
    expect(ranked[0].id).toBe("b");
  });
});
