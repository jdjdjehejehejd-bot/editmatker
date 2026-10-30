import { describe, expect, it } from "vitest";
import { checkUserInput, findBlockedWords, isTextAllowed, isTopicAllowed, judgeFrames, shouldBlockTopic } from "./moderation";

const words = (text: string) => findBlockedWords(text).map(m => m.word);

describe("금지어 검사", () => {
  it("성적·욕설·혐오·잔혹 단어를 잡는다", () => {
    expect(words("야동 모음")).toContain("야동");
    expect(words("best porn clips")).toContain("porn");
    expect(words("씨발 하이라이트")).toContain("씨발");
    expect(words("beheading video")).toContain("beheading");
    expect(findBlockedWords("병신")[0].category).toBe("욕설·혐오");
  });

  it("띄어쓰기·기호·숫자 치환·초성 변형도 잡는다", () => {
    expect(words("씨 발")).toContain("씨발");
    expect(words("씨.발")).toContain("씨발");
    expect(words("씨이발")).toContain("씨발");
    expect(words("p0rn")).toContain("porn");
    expect(words("p o r n")).toContain("porn");
    expect(words("N.S.F.W")).toContain("nsfw");
    expect(words("ㅅㅂ")).toContain("ㅅㅂ");
    expect(words("ＰＯＲＮ")).toContain("porn");
    expect(words("섹시porn")).toContain("porn");
  });

  it("멀쩡한 말은 막지 않는다", () => {
    for (const ok of ["시발점", "강아지 새끼", "고양이 새끼 모음", "보지 마세요", "자지 마", "Sussex", "Essex", "class", "grape juice", "Al Gore", "Moby Dick", "Scunthorpe", "손흥민 골", "아폴로 11호", "Tottenham Hotspur F.C.", "cocktail", "documentary"]) {
      expect(words(ok), ok).toEqual([]);
    }
  });

  it("여러 값을 한꺼번에 검사한다", () => {
    expect(isTextAllowed("Cat zoomies", "u/fan · r/cats", null)).toBe(true);
    expect(isTextAllowed("Cat zoomies", "r/gonewild")).toBe(false);
  });

  it("입력에 금지어가 있으면 이유를 알려 준다", () => {
    expect(checkUserInput("고양이", "신나는 빠른 컷")).toBeNull();
    expect(checkUserInput("고양이, 야동", "")).toMatch(/^생성 불가 — 부적절한 단어\(성적\)/);
    expect(checkUserInput("고양이", "fucking hype")).toMatch(/욕설·혐오/);
  });
});

describe("장면 판정", () => {
  const safe = { porn: 0.01, hentai: 0.01, sexy: 0.05 };
  it("노골적인 장면이 하나라도 있으면 막는다", () => {
    expect(judgeFrames([safe, { porn: 0.5, hentai: 0.2, sexy: 0.1 }, safe]).blocked).toBe(true);
  });
  it("선정적인 장면은 두 번 이상일 때만 막는다", () => {
    expect(judgeFrames([safe, { porn: 0, hentai: 0, sexy: 0.9 }]).blocked).toBe(false);
    expect(judgeFrames([{ porn: 0, hentai: 0, sexy: 0.9 }, { porn: 0, hentai: 0, sexy: 0.95 }]).blocked).toBe(true);
  });
  it("평범한 장면은 통과", () => {
    expect(judgeFrames([safe, safe, safe])).toEqual({ blocked: false, reason: null });
  });
});

describe("주제 단위 차단", () => {
  it("찾은 영상의 30% 이상(최소 2개)이 검열 대상이면 막는다", () => {
    expect(shouldBlockTopic(0, 10)).toBe(false);
    expect(shouldBlockTopic(1, 2)).toBe(false); // 우연한 1개는 봐준다
    expect(shouldBlockTopic(2, 10)).toBe(false); // 20%
    expect(shouldBlockTopic(3, 10)).toBe(true); // 30%
    expect(shouldBlockTopic(2, 2)).toBe(true);
    expect(shouldBlockTopic(0, 0)).toBe(false);
  });

  it("주제가 가리키는 대상의 설명이 부적절하면 막는다", () => {
    expect(isTopicAllowed({ query: "어떤 이름", label: "어떤 이름", englishLabel: "Some Name", description: "Japanese pornographic actress" })).toBe(false);
    expect(isTopicAllowed({ query: "손흥민", label: "손흥민", englishLabel: "Son Heung-min", description: "South Korean footballer" })).toBe(true);
  });
});
