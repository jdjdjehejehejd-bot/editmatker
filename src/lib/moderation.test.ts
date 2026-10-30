import { describe, expect, it } from "vitest";
import { checkUserInput, findBlockedWords, isNsfwRequested, isTextAllowed, isTopicAllowed, judgeFrames, screenFrames, shouldBlockTopic } from "./moderation";

const words = (text: string) => findBlockedWords(text).map(m => m.word);
const wordsNsfw = (text: string) => findBlockedWords(text, { nsfw: true }).map(m => m.word);

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
  const skin = { porn: 0.05, hentai: 0.02, sexy: 0.92 }; // 상의 탈의한 경기 장면처럼 노출만 많은 화면
  it("아주 확실한 노골적 장면은 하나만 있어도 막는다", () => {
    expect(judgeFrames([safe, { porn: 0.8, hentai: 0.1, sexy: 0.1 }, safe]).blocked).toBe(true);
  });
  it("애매한 노골적 장면 하나로는 막지 않고, 두 개면 막는다", () => {
    const maybe = { porn: 0.5, hentai: 0.2, sexy: 0.1 };
    expect(judgeFrames([safe, maybe, safe]).blocked).toBe(false);
    expect(judgeFrames([maybe, safe, maybe]).blocked).toBe(true);
  });
  it("노출(선정적) 장면은 세 개 이상일 때만 막는다", () => {
    expect(judgeFrames([skin, skin, safe]).blocked).toBe(false);
    expect(judgeFrames([skin, skin, skin]).blocked).toBe(true);
  });
  it("스포츠 주제는 경기 중 노출로 막지 않지만 노골적인 장면은 막는다", () => {
    const fight = Array.from({ length: 10 }, () => skin);
    expect(judgeFrames(fight, { sports: true }).blocked).toBe(false);
    expect(judgeFrames(fight).blocked).toBe(true);
    expect(judgeFrames([safe, { porn: 0.98, hentai: 0, sexy: 0 }], { sports: true })).toMatchObject({ blocked: true, certain: true });
    expect(judgeFrames([{ porn: 0.7, hentai: 0, sexy: 0.2 }, { porn: 0.7, hentai: 0, sexy: 0.2 }], { sports: true }).blocked).toBe(false);
  });
  it("스포츠 영상은 몸싸움·맨살 오탐(0.9 한두 장면)으로 막지 않고, 여러 장면이면 그 영상만 뺀다", () => {
    const grapple = { porn: 0.9, hentai: 0.02, sexy: 0.3 };
    expect(judgeFrames([grapple, safe, safe, safe], { sports: true }).blocked).toBe(false);
    expect(judgeFrames([grapple, grapple, safe, safe], { sports: true }).blocked).toBe(false);
    // 일반 영상에서는 같은 장면 둘이면 막습니다.
    expect(judgeFrames([grapple, grapple, safe, safe]).blocked).toBe(true);
    // 스포츠에서 여러 장면이 걸려도 확실한 장면이 없으면 주제 전체 차단에는 세지 않습니다.
    expect(judgeFrames([grapple, grapple, grapple], { sports: true })).toMatchObject({ blocked: true, certain: false });
  });
  it("선수 이름·직업 속 금지어 글자는 막지 않음", () => {
    expect(isTextAllowed("펠라이니 헤딩골")).toBe(true);
    expect(isTextAllowed("축구 애널리스트 분석")).toBe(true);
    expect(isTextAllowed("펠라 영상")).toBe(false);
  });
  it("평범한 장면은 통과", () => {
    expect(judgeFrames([safe, safe, safe])).toEqual({ blocked: false, reason: null });
  });
});

describe("NSFW 모드", () => {
  it("특징·분위기에 NSFW를 적으면 켜진다", () => {
    for (const on of ["NSFW", "nsfw", "NSFW 시네마틱", "N.S.F.W", "n s f w", "무검열", "19+", "uncensored", "no censor"]) expect(isNsfwRequested(on), on).toBe(true);
  });

  it("표시가 없으면 꺼진 상태다", () => {
    for (const off of ["", "   ", "웅장하고 시네마틱하게", "빠른 컷, 네온, 120bpm", null, undefined]) expect(isNsfwRequested(off), String(off)).toBe(false);
  });

  it("성적 단어와 성인물 표시는 통과시킨다", () => {
    expect(wordsNsfw("야동 모음")).toEqual([]);
    expect(wordsNsfw("best porn clips")).toEqual([]);
    expect(wordsNsfw("N.S.F.W")).toEqual([]);
    expect(checkUserInput("고양이", "NSFW")).toBeNull();
    expect(checkUserInput("성인배우", "nsfw, 시네마틱")).toBeNull();
  });

  it("표시가 없으면 성적 단어는 그대로 막는다", () => {
    expect(words("야동 모음")).toContain("야동");
    expect(checkUserInput("고양이", "야동")).toMatch(/성적/);
  });

  it("NSFW여도 욕설·잔혹·약물과 아동·비동의 관련은 막는다", () => {
    expect(wordsNsfw("씨발")).toContain("씨발");
    expect(wordsNsfw("beheading video")).toContain("beheading");
    expect(wordsNsfw("rape")).toContain("rape");
    expect(wordsNsfw("아동학대")).toContain("아동학대");
    expect(wordsNsfw("pedophile")).toContain("pedophile");
    expect(wordsNsfw("마약")).toContain("마약");
    expect(checkUserInput("고양이", "nsfw, 씨발")).toMatch(/욕설·혐오/);
  });

  it("주제 설명이 성인물이어도 NSFW면 통과한다", () => {
    const info = { query: "이름", label: "이름", englishLabel: "Some Name", description: "Japanese pornographic actress" };
    expect(isTopicAllowed(info)).toBe(false);
    expect(isTopicAllowed(info, { nsfw: true })).toBe(true);
  });

  it("장면 검사는 NSFW 모드에서 모델 없이 통과한다", async () => {
    await expect(screenFrames([{} as HTMLCanvasElement], { nsfw: true })).resolves.toEqual({ blocked: false, reason: null });
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
