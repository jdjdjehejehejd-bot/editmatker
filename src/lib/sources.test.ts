import { describe, expect, it } from "vitest";
import { buildArchiveQuery, downloadSource, uploadedSource, buildCommonsQueries, inspectArchiveFiles, REASON, normalizeLicense, parseCommonsPage, pickArchiveFile, rankSources, resolveLicense, type TopicInfo } from "./sources";

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

  it("별칭과 관련 주제도 Commons·Internet Archive 검색어에 넣는다", () => {
    const wide = { ...topic, aliases: ["Apollo XI"], related: ["Saturn V", "Neil Armstrong"] };
    const queries = buildCommonsQueries(wide, []);
    expect(queries).toContain('filetype:video "Apollo XI"');
    expect(queries.at(-1)).toBe('filetype:video "Apollo 11" "Neil Armstrong"');
    expect(buildArchiveQuery(wide, [], "any")).toContain('("Apollo 11" OR "Apollo XI")');
    expect(buildArchiveQuery(wide, [], "any", true)).toContain('("Apollo 11" OR "Apollo XI") AND ("Saturn V" OR "Neil Armstrong")');
  });

  it("분류·영어 이름·힌트로 검색어를 만든다", () => {
    const queries = buildCommonsQueries(topic, ["launch"]);
    // 분류 검색은 searchCommons가 따로 하고, 이름은 늘 따옴표로 묶는다
    expect(queries[0]).toBe('filetype:video "Apollo 11" launch');
    expect(queries.some(q => !q.includes('"'))).toBe(false);
    expect(queries).toContain('filetype:video "Apollo 11" launch');
  });

  it("Internet Archive 검색은 모드에 따라 라이선스 조건을 붙인다", () => {
    expect(buildArchiveQuery(topic, [], "reusable")).toContain("licenseurl:");
    expect(buildArchiveQuery(topic, [], "any")).not.toContain("licenseurl:");
    expect(buildArchiveQuery(topic, [], "any")).toContain("NOT collection:(inlibrary");
  });

  it("재생할 수 있는 가장 작은 영상 파일을 고른다 (mp4·webm·ogv)", () => {
    const file = pickArchiveFile([
      { name: "a.txt", size: "10" },
      { name: "big.mp4", size: String(500 * 1024 * 1024) },
      { name: "a_512kb.mp4", size: "30000000", length: "02:30" },
      { name: "a.mp4", size: "60000000", length: "150" },
    ]);
    expect(file).toEqual({ name: "a_512kb.mp4", bytes: 30_000_000, duration: 150 });
    expect(pickArchiveFile([{ name: "a.ogv", size: "100" }, { name: "a.mp4", size: "200" }])?.name).toBe("a.ogv");
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

describe("검색 결과 요약", () => {
  it("출처별로 실패·결과 없음·걸러짐을 구분해 보여 준다", async () => {
    const { summarizeReports, describeError } = await import("./sources");
    expect(describeError(new TypeError("Failed to fetch"))).toBe("접속이 막혔어요(네트워크·CORS)");
    expect(
      summarizeReports([
        { provider: "Reddit", usable: 0, scanned: 0, error: "응답 오류 403" },
        { provider: "Wikimedia Commons", usable: 0, scanned: 7 },
        { provider: "Internet Archive", usable: 0, scanned: 0 },
        { provider: "YouTube", usable: 3, scanned: 3 },
      ])
    ).toBe(
      [
        "Reddit: 실패 — 응답 오류 403",
        "Wikimedia Commons: 7개 찾았지만 쓸 수 있는 영상 없음",
        "Internet Archive: 검색 결과 없음",
        "YouTube: 3개",
      ].join("\n")
    );
  });
});

describe("못 쓴 이유", () => {
  it("Commons 파일마다 탈락 이유를 알려 준다", async () => {
    const { inspectCommonsPage, REASON } = await import("./sources");
    const base = { mediatype: "VIDEO", duration: 60, extmetadata: { LicenseShortName: { value: "CC0" } }, derivatives: [{ src: "https://upload.wikimedia.org/a.webm", type: "video/webm", height: 480, bandwidth: 1000 }] };
    const noWebm = (mime: string) => !mime.includes("webm");
    expect(inspectCommonsPage({ title: "File:a.webm", videoinfo: [base] }, 1, "any", noWebm).reason).toBe(REASON.format);
    expect(inspectCommonsPage({ title: "File:a.webm", videoinfo: [{ ...base, duration: 6000 }] }, 1, "any").reason).toBe(REASON.length);
    expect(inspectCommonsPage({ title: "File:a.webm", videoinfo: [{ ...base, extmetadata: { LicenseShortName: { value: "CC BY-NC 4.0" } } }] }, 1, "reusable").reason).toBe(REASON.license);
    expect(inspectCommonsPage({ title: "File:a.jpg", imageinfo: [{ mediatype: "BITMAP" }] }, 1, "any").reason).toBeNull();
  });

  it("Internet Archive는 mp4·webm·ogv 중 재생 가능한 가장 작은 파일을 고르고, 못 쓰면 이유를 준다", async () => {
    const { inspectArchiveFiles, REASON } = await import("./sources");
    expect(inspectArchiveFiles([{ name: "a.ogv", size: "1000", length: "60" }, { name: "a.mp4", size: "5000", length: "60" }]).file?.name).toBe("a.ogv");
    expect(inspectArchiveFiles([{ name: "a.ogv", size: "1000" }], m => m === "video/mp4").reason).toBe(REASON.format);
    expect(inspectArchiveFiles([{ name: "a.txt" }]).reason).toBe(REASON.noVideo);
    expect(inspectArchiveFiles([{ name: "film.mp4", size: "1000", length: "02:30:00" }]).reason).toBe(REASON.length);
    expect(inspectArchiveFiles([{ name: "film.mp4", size: String(900 * 1024 * 1024), length: "40:00" }]).reason).toBe(REASON.size);
    // 40분짜리라도 파일이 작으면 쓸 수 있다(예전엔 25분 넘으면 무조건 뺐음)
    expect(inspectArchiveFiles([{ name: "talk.mp4", size: "50000000", length: "40:00" }]).file?.name).toBe("talk.mp4");
  });

  it("오류 메시지에 가장 흔한 이유를 보여 준다", async () => {
    const { summarizeReports } = await import("./sources");
    expect(summarizeReports([{ provider: "Internet Archive", usable: 0, scanned: 10, rejected: { "너무 짧거나 김": 6, "파일이 너무 큼": 3, "영상 파일 없음": 1 } }])).toBe(
      "Internet Archive: 10개 찾았지만 쓸 수 있는 영상 없음 — 너무 짧거나 김 6개, 파일이 너무 큼 3개, 영상 파일 없음 1개"
    );
  });
});

describe("휴대폰 화질 선택", () => {
  it("긴 영상은 기기 크기 제한 안에 들어오는 낮은 화질 변환본을 고른다", () => {
    const page = {
      pageid: 9,
      title: "File:Long_interview.webm",
      videoinfo: [
        {
          mediatype: "VIDEO",
          duration: 40 * 60,
          extmetadata: { LicenseShortName: { value: "CC0" } },
          derivatives: [
            { src: "https://upload.wikimedia.org/480.webm", type: "video/webm", height: 480, bandwidth: 1_000_000 },
            { src: "https://upload.wikimedia.org/360.webm", type: "video/webm", height: 360, bandwidth: 600_000 },
            { src: "https://upload.wikimedia.org/240.webm", type: "video/webm", height: 240, bandwidth: 250_000 },
          ],
        },
      ],
    };
    // 40분 × 1Mbps = 300MB(너무 큼), 360p = 180MB(너무 큼), 240p = 75MB → 240p
    expect(parseCommonsPage(page, 1, "any", () => true)?.mediaUrl).toBe("https://upload.wikimedia.org/240.webm");
  });
});

describe("Internet Archive 비공개 파일", () => {
  it("private 파일은 고르지 않고, 전부 비공개면 내려받기 제한으로 셈", () => {
    const canPlay = () => true;
    expect(inspectArchiveFiles([{ name: "a.mp4", size: "1000", private: "true" }, { name: "b.mp4", size: "2000" }], canPlay).file?.name).toBe("b.mp4");
    expect(inspectArchiveFiles([{ name: "a.mp4", size: "1000", private: "true" }], canPlay)).toEqual({ file: null, reason: REASON.restricted });
  });
});

describe("직접 올린 영상", () => {
  it("내려받지 않고 올린 파일을 그대로 씀", async () => {
    const file = new File([new Uint8Array(10)], "my clip.mp4", { type: "video/mp4" });
    const source = uploadedSource(file, 0);
    expect(source).toMatchObject({ provider: "내 영상", title: "my clip", trusted: true, bytes: 10 });
    let progress = 0;
    expect(await downloadSource(source, r => (progress = r), undefined, 1)).toBe(file);
    expect(progress).toBe(1);
  });
});

describe("검색 결과 재사용", () => {
  it("같은 조건으로 다시 찾으면 네트워크를 다시 부르지 않음", async () => {
    const { findSources } = await import("./sources");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      const url = String(input);
      const body = url.includes("mixkit") || url.includes("provider=mixkit") ? "" : url.includes("api/stock") ? JSON.stringify({ error: "API 키 필요" }) : "{}";
      return new Response(body, { status: url.includes("api/stock") && !url.includes("mixkit") ? 501 : 200 });
    }) as typeof fetch;
    try {
      const topic = { query: "캐시테스트", label: "캐시테스트", englishLabel: "Cache Test", description: null, commonsCategory: null, wikidataVideos: [], aliases: [], related: [] };
      await findSources(topic, [], "reusable", null);
      const first = calls;
      expect(first).toBeGreaterThan(0);
      await findSources(topic, [], "reusable", null);
      expect(calls).toBe(first);
    } finally {
      globalThis.fetch = original;
    }
  });
});
