import { afterEach, describe, expect, it, vi } from "vitest";
import { expandQueries, pickAliases, pickRelatedIds, resolveTopic, topicNames, type TopicInfo } from "./topic";

afterEach(() => vi.unstubAllGlobals());

const item = (id: string, qualifiers?: object) => ({ mainsnak: { datavalue: { value: { id } } }, ...(qualifiers ? { qualifiers } : {}) });

describe("관련 주제 고르기", () => {
  it("현재 소속을 예전 소속보다 먼저 고른다", () => {
    const entity = {
      claims: {
        P54: [item("Q_old_team", { P582: [{}] }), item("Q_spurs"), item("Q_korea")],
        P641: [item("Q_football")],
      },
    };
    expect(pickRelatedIds(entity)).toEqual(["Q_korea", "Q_spurs", "Q_football"]);
  });

  it("별칭에서 겹치거나 쓰기 어려운 이름을 뺀다", () => {
    const entity = { aliases: { en: [{ value: "Sonny" }, { value: "Son Heung-min" }, { value: "S" }], ko: [{ value: "쏘니" }] } };
    expect(pickAliases(entity, ["손흥민", "Son Heung-min"])).toEqual(["Sonny", "쏘니"]);
  });
});

describe("expandQueries", () => {
  const topic: TopicInfo = {
    query: "손흥민", label: "손흥민", englishLabel: "Son Heung-min", description: null, commonsCategory: null, wikidataVideos: [],
    aliases: ["Sonny", "쏘니"], related: ["Tottenham Hotspur F.C.", "South Korea national football team", "association football", "Harry Kane"],
  };

  it("한국어·영어 이름, 별칭, 관련 주제를 순서대로 넣고 가중치를 낮춘다", () => {
    expect(expandQueries(topic, ["goal"])).toEqual([
      { q: "손흥민", weight: 1, kind: "name" },
      { q: "Son Heung-min goal", weight: 1, kind: "name" },
      { q: "Son Heung-min", weight: 0.95, kind: "name" },
      { q: "Sonny", weight: 0.85, kind: "alias" },
      { q: "쏘니", weight: 0.85, kind: "alias" },
      { q: "Tottenham Hotspur F.C.", weight: 0.6, kind: "related" },
      { q: "South Korea national football team", weight: 0.6, kind: "related" },
    ]);
  });

  it("최대 개수를 지킨다", () => {
    expect(expandQueries(topic, [], 3)).toHaveLength(3);
  });

  it("주제를 부르는 모든 이름을 모은다", () => {
    expect(topicNames(topic)).toEqual(["손흥민", "Son Heung-min", "Sonny", "쏘니"]);
  });
});

describe("resolveTopic", () => {
  it("Wikidata 직접 검색이 실패하면 Wikipedia로 항목을 찾고 별칭·관련 주제를 채운다", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      const p = url.searchParams;
      if (p.get("action") === "wbsearchentities") return Response.json({ search: [] });
      if (url.hostname === "ko.wikipedia.org") return Response.json({ query: { pages: { 1: { pageprops: { wikibase_item: "Q1" } } } } });
      if (p.get("action") === "wbgetentities" && p.get("ids") === "Q1") {
        return Response.json({
          entities: {
            Q1: {
              labels: { ko: { value: "뉴진스" }, en: { value: "NewJeans" } },
              aliases: { en: [{ value: "NJZ" }] },
              claims: { P527: [item("Q2")], P373: [{ mainsnak: { datavalue: { value: "NewJeans" } } }] },
              sitelinks: { enwiki: { title: "NewJeans" } },
            },
          },
        });
      }
      if (p.get("action") === "wbgetentities") return Response.json({ entities: { Q2: { labels: { en: { value: "Hanni" } } } } });
      if (p.get("list") === "search") return Response.json({ query: { search: [{ title: "Le Sserafim" }, { title: "NewJeans" }] } });
      return new Response("not found", { status: 404 });
    });
    const topic = await resolveTopic("뉴진스");
    expect(topic).toMatchObject({ label: "뉴진스", englishLabel: "NewJeans", commonsCategory: "NewJeans", aliases: ["NJZ"], related: ["Hanni", "Le Sserafim"] });
  });

  it("아무것도 못 찾으면 입력값 그대로 쓴다", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    expect(await resolveTopic("asdfqwer")).toMatchObject({ query: "asdfqwer", englishLabel: null, related: [] });
  });
});

describe("여러 주제 입력", () => {
  it("쉼표로 나누고 N:단어: 를 N배 비중으로 읽는다", async () => {
    const { parseTopicInput } = await import("./topic");
    expect(parseTopicInput("손흥민, 3:케인:, 토트넘")).toEqual([
      { term: "손흥민", weight: 1 },
      { term: "케인", weight: 3 },
      { term: "토트넘", weight: 1 },
    ]);
    // 끝 콜론 생략, 전각 쉼표·콜론, 소수, 공백
    expect(parseTopicInput("2 : Tokyo ，0.5：서울：")).toEqual([
      { term: "Tokyo", weight: 2 },
      { term: "서울", weight: 0.5 },
    ]);
    // 빈 항목·중복은 정리하고 비중은 큰 쪽을 남긴다, 숫자로 시작하는 주제명은 그대로
    expect(parseTopicInput("고양이,, 4:고양이:, 아폴로 11호")).toEqual([
      { term: "고양이", weight: 4 },
      { term: "아폴로 11호", weight: 1 },
    ]);
    expect(parseTopicInput("100:a:")[0].weight).toBe(10);
    expect(parseTopicInput("12:00 뉴스")).toEqual([{ term: "12:00 뉴스", weight: 1 }]);
    expect(parseTopicInput("1, 2, 3, 4, 5, 6, 7")).toHaveLength(6);
  });

  it("영상 칸을 비중대로 나누고 모든 주제에 최소 1칸을 준다", async () => {
    const { allocateSlots } = await import("./topic");
    expect(allocateSlots([1, 3, 1], 5)).toEqual([1, 3, 1]);
    expect(allocateSlots([1, 1], 4)).toEqual([2, 2]);
    expect(allocateSlots([3, 1], 4)).toEqual([3, 1]);
    expect(allocateSlots([1, 1, 1], 4).reduce((a, b) => a + b)).toBe(4);
    // 칸이 주제보다 적으면 비중 큰 주제부터
    expect(allocateSlots([1, 5, 2], 2)).toEqual([0, 1, 1]);
    expect(allocateSlots([10, 1, 1], 3)).toEqual([1, 1, 1]);
  });

  it("제목을 합친다", async () => {
    const { combinedTitle } = await import("./topic");
    expect(combinedTitle(["손흥민"])).toBe("손흥민");
    expect(combinedTitle(["A", "B", "C", "D", "E"])).toBe("A × B × C 외 2");
  });
});
