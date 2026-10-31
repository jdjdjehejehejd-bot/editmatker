import { describe, expect, it } from "vitest";
import { applyOverrides, parseStyle, sanitizeOverrides } from "./style";

describe("parseStyle", () => {
  it("기본값은 하이프 스타일", () => {
    const style = parseStyle("");
    expect(style.mood).toBe("hype");
    expect(style.bpm).toBe(140);
  });

  it("한국어 특징에서 무드·색감·효과·검색 힌트를 읽는다", () => {
    const style = parseStyle("웅장하고 시네마틱하게, 흑백, 글리치, 골 장면");
    expect(style.mood).toBe("cinematic");
    expect(style.grade).toBe("mono");
    expect(style.effects.has("glitch")).toBe(true);
    expect(style.searchHints).toContain("goal");
  });

  it("감성 무드와 BPM 지정", () => {
    const style = parseStyle("잔잔한 감성 95bpm 따뜻한 색감");
    expect(style.mood).toBe("emotional");
    expect(style.bpm).toBe(95);
    expect(style.grade).toBe("warm");
  });

  it("깔끔하게 요청하면 거친 효과를 뺀다", () => {
    const style = parseStyle("레트로 깔끔하게");
    expect(style.mood).toBe("retro");
    expect(style.effects.has("glitch")).toBe(false);
    expect(style.effects.has("grain")).toBe(false);
  });
});

describe("배경음악 템포", () => {
  it("장르별 기본 템포와 직접 적은 템포를 구분한다", async () => {
    const { defaultBpm } = await import("./style");
    expect(defaultBpm("hype")).toBe(140);
    expect(defaultBpm("emotional")).toBe(80);
    expect(parseStyle("감성 95bpm").bpmExplicit).toBe(true);
    expect(parseStyle("감성").bpmExplicit).toBe(false);
  });
});

describe("applyOverrides", () => {
  it("직접 설정한 분위기·템포·색감이 자동 값을 덮어씀", () => {
    const style = applyOverrides(parseStyle("빠르고 신나는", { mood: "cinematic" }), { mood: "cinematic", bpm: 90, grade: "mono" });
    expect(style.mood).toBe("cinematic");
    expect(style.bpm).toBe(90);
    expect(style.bpmExplicit).toBe(true);
    expect(style.grade).toBe("mono");
  });

  it("효과를 켜고 끔", () => {
    const base = parseStyle("");
    const first = [...base.effects][0];
    const style = applyOverrides(base, { effects: { [first]: false, letterbox: true } });
    expect(style.effects.has(first)).toBe(false);
    expect(style.effects.has("letterbox")).toBe(true);
  });

  it("컷 속도는 박자 패턴을 줄이거나 늘림", () => {
    const base = parseStyle("");
    const fast = applyOverrides(base, { pace: "fast" });
    const slow = applyOverrides(base, { pace: "slow" });
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    expect(sum(fast.cutBeats.drop)).toBeLessThanOrEqual(sum(base.cutBeats.drop));
    expect(sum(slow.cutBeats.drop)).toBeGreaterThan(sum(base.cutBeats.drop));
    expect(applyOverrides(base, {})).toEqual({ ...base, transition: undefined });
  });

  it("잘못된 값은 버림", () => {
    expect(sanitizeOverrides({ mood: "constructor", bpm: 999, grade: "x", effects: { zoom: "y", toString: true }, pace: "fast" })).toEqual({ pace: "fast" });
    expect(sanitizeOverrides(null)).toEqual({});
  });
});

describe("특징 문장에서 편집 스타일 읽기", () => {
  it("여러 표현의 분위기를 알아들음", () => {
    expect(parseStyle("긴장감 있고 소름 돋게").mood).toBe("cinematic");
    expect(parseStyle("부드럽고 아련하게").mood).toBe("emotional");
    expect(parseStyle("멋있고 타격감 있게").mood).toBe("hype");
    expect(parseStyle("시티팝 느낌").mood).toBe("retro");
  });

  it("컷 속도·전환을 읽음", () => {
    const fast = parseStyle("빠른 컷으로 정신없게");
    expect(fast.pace).toBe("fast");
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    expect(sum(fast.cutBeats.drop)).toBeLessThan(sum(parseStyle("").cutBeats.drop));
    expect(parseStyle("천천히 롱테이크로").pace).toBe("slow");
    expect(parseStyle("페이드로 부드럽게 넘어가게").transition).toBe("fade");
    expect(parseStyle("휩 전환").transition).toBe("whip");
  });

  it("빼 달라는 효과는 뺌", () => {
    expect(parseStyle("시네마틱하게, 슬로모션 없이").effects.has("slowmo")).toBe(false);
    expect(parseStyle("하이프, 흔들림 빼고").effects.has("shake")).toBe(false);
    expect(parseStyle("no glitch, retro").effects.has("glitch")).toBe(false);
    expect(parseStyle("글리치 넣어서").effects.has("glitch")).toBe(true);
  });

  it("빠른/느린 템포와 읽은 말 목록", () => {
    expect(parseStyle("빠른 비트").bpm).toBe(parseStyle("").bpm + 15);
    const style = parseStyle("웅장하게, 흑백, 120bpm");
    expect(style.bpm).toBe(120);
    expect(style.matched).toEqual(expect.arrayContaining(["웅장", "흑백", "120bpm"]));
    expect(parseStyle("fade transitions, fast cuts").searchHints).toEqual([]);
  });

  it("직접 고른 컷 속도는 특징에서 읽은 속도를 대신함", () => {
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    const base = parseStyle("");
    const normal = applyOverrides(parseStyle("빠른 컷"), { pace: "normal" });
    expect(sum(normal.cutBeats.drop)).toBeGreaterThanOrEqual(sum(base.cutBeats.drop) - 2);
    expect(normal.pace).toBe("normal");
  });
});

describe("특징 문장의 장면 분위기", () => {
  it("장면 낱말을 장면 선호로 읽음", () => {
    expect(parseStyle("어두운 밤 장면 위주로, 관중 함성").scene).toMatchObject({ brightness: "dark", loud: true });
    expect(parseStyle("선수 얼굴 클로즈업, 화려하게").scene).toMatchObject({ people: true, colorful: true });
    expect(parseStyle("바다랑 파도, 자동차 질주").scene).toMatchObject({ subjects: ["ocean", "car racing"], intensity: "intense" });
    expect(parseStyle("웅장하게").scene).toBeUndefined();
  });

  it("한 글자 낱말이 다른 말 속에 든 경우는 대상으로 보지 않음", () => {
    expect(parseStyle("산책하는 느낌, 3개 장면").scene?.subjects).toBeUndefined();
    expect(parseStyle("설산과 산 풍경").scene?.subjects).toEqual(["mountain"]);
    expect(parseStyle("귀여운 개 영상").scene?.subjects).toEqual(["dog"]);
  });

  it("격렬한 장면은 컷을 빠르게(분위기가 이미 빠르면 그대로)", () => {
    expect(parseStyle("웅장하고 장엄하게, 격렬한 장면").pace).toBe("fast");
    expect(parseStyle("하이프, 격렬하게").pace).toBeUndefined();
    expect(parseStyle("웅장하고 고요한 장면").pace).toBe("slow");
    expect(parseStyle("고요한 장면").pace).toBeUndefined(); // 감성이라 이미 느림
    expect(parseStyle("격렬한 장면, 천천히").pace).toBe("slow"); // 직접 말한 컷 속도가 우선
  });
});

describe("특징 문장의 화면 느낌과 흐름", () => {
  it("느낌 낱말을 화면 보정으로", () => {
    expect(parseStyle("어둡고 무거운 분위기").look).toMatchObject({ exposure: 0.86, vignette: 1.5 });
    expect(parseStyle("밝고 청량하게").look).toMatchObject({ exposure: 1.08, vignette: 0.6 });
    expect(parseStyle("몽환적이고 꿈 같은").look?.glow).toBe(1);
    expect(parseStyle("물 빠진 색, 부드럽게").look).toMatchObject({ saturation: 0.75, contrast: 0.9 });
    expect(parseStyle("웅장하게").look).toBeUndefined();
  });

  it("흐름 낱말을 드롭 위치·아웃트로로", () => {
    expect(parseStyle("점점 고조되게").structure).toEqual({ dropRatio: 0.4 });
    expect(parseStyle("처음부터 터지게").structure).toEqual({ dropRatio: 0.08 });
    expect(parseStyle("여운 있게 마무리").structure).toEqual({ outroBeats: 8 });
    expect(parseStyle("").structure).toBeUndefined();
  });
});

describe("특징 문장의 키워드", () => {
  it("스타일 낱말·일반적인 말·조사를 빼고 내용 키워드만", async () => {
    const { contentKeywords } = await import("./style");
    expect(contentKeywords("손흥민 골 장면 위주로, 웅장하게")).toEqual(["손흥민", "골"]);
    expect(contentKeywords("무대에서 춤추는 장면, 흑백, 슬로모션 없이")).toEqual(expect.arrayContaining(["무대", "춤추"]));
    expect(contentKeywords("웅장하고 시네마틱하게")).toEqual([]);
  });

  it("제목에 키워드가 나오는지 (한 글자는 낱말일 때만)", async () => {
    const { countKeywordHits } = await import("./style");
    expect(countKeywordHits("Son 결승골 하이라이트", ["골"])).toBe(1);
    expect(countKeywordHits("골프 대회", ["골"])).toBe(0);
    expect(countKeywordHits("Best DUNK compilation", ["dunk"])).toBe(1);
  });

  it("결정적 동작·반응·감정 낱말을 장면 선호로", () => {
    expect(parseStyle("골 장면 위주로").scene).toMatchObject({ impact: true, loud: true });
    expect(parseStyle("골프 치는 장면").scene?.impact).toBeUndefined();
    expect(parseStyle("우승 세리머니").scene).toMatchObject({ loud: true, people: true });
    expect(parseStyle("눈물 나는 장면").scene).toMatchObject({ people: true });
  });
});

describe("NSFW 특징", () => {
  it("NSFW 표시를 적으면 성적 묘사도 검색 힌트·키워드로 읽는다", () => {
    const style = parseStyle("nsfw, 섹시한 비키니");
    expect(style.searchHints).toContain("bikini");
    expect(style.searchHints).toContain("sexy");
    expect(style.keywords).toEqual(expect.arrayContaining(["bikini", "sexy"]));
    // 검열 표시 자체는 검색어가 아닙니다.
    expect(style.searchHints).not.toContain("nsfw");
  });

  it("NSFW 표시가 없으면 성적 묘사를 검색어로 옮기지 않는다", () => {
    expect(parseStyle("비키니").searchHints).not.toContain("bikini");
    expect(parseStyle("섹시한 댄스").searchHints).toEqual(["dance"]);
  });
});

describe("NSFW 성적 낱말 확장", () => {
  it("에로틱·섹슈얼·섹스·엣지도 검색 힌트로 인식한다", () => {
    const style = parseStyle("nsfw, 에로틱한 무드, 섹슈얼, 섹스, 엣지");
    expect(style.searchHints).toEqual(expect.arrayContaining(["erotic", "sexual", "sex", "ecchi"]));
    expect(style.searchHints).not.toContain("nsfw");
  });

  it("NSFW 표시가 없으면 새 낱말도 검색어로 쓰지 않는다", () => {
    expect(parseStyle("섹스 엣지").searchHints).toEqual([]);
  });

  it("NSFW 표시가 없으면 에로틱·섹슈얼도 아무 효과가 없다", () => {
    for (const text of ["에로틱", "섹슈얼한 분위기", "erotic"]) {
      const style = parseStyle(text);
      expect(style.mood, text).toBe("hype");
      expect(style.transition, text).toBeUndefined();
      expect(style.effects.has("slowmo"), text).toBe(false);
      expect(style.searchHints, text).toEqual([]);
      expect(style.look, text).toBeUndefined();
    }
  });

  it("NSFW에서는 어떤 성적 낱말이든 감성 결이 자동으로 붙는다", () => {
    for (const text of ["nsfw, 야동", "nsfw, 포르노", "nsfw, 성인배우", "nsfw, porn"]) {
      const style = parseStyle(text);
      expect(style.mood, text).toBe("emotional");
      expect(style.grade, text).toBe("warm");
      expect(style.effects.has("slowmo"), text).toBe(true);
      expect(style.effects.has("zoom"), text).toBe(true);
      expect(style.transition, text).toBe("fade");
      expect(style.searchHints, text).toContain("sexy");
      expect(style.matched, text).not.toHaveLength(0);
    }
  });

  it("NSFW와 함께 적으면 에로틱·섹슈얼도 성적 결을 적용한다", () => {
    const style = parseStyle("nsfw, 에로틱");
    expect(style.mood).toBe("emotional");
    expect(style.grade).toBe("warm");
    expect(style.transition).toBe("fade");
    expect(style.effects.has("slowmo")).toBe(true);
    expect(style.searchHints).toContain("erotic");
    expect(style.matched).toContain("에로틱");
    expect(parseStyle("nsfw, 섹슈얼한 분위기").searchHints).toContain("sexual");
  });
});

describe("NSFW 낱말을 편집 스타일 자동에서 읽음", () => {
  it("편집 스타일의 \"특징에서 읽은 말\"에 성적 묘사가 나온다", () => {
    const style = parseStyle("nsfw, 섹시한 비키니, 엣지");
    expect(style.matched).toEqual(expect.arrayContaining(["섹시", "비키니", "엣지"]));
  });

  it("NSFW 표시가 없으면 읽은 말에 성적 묘사를 넣지 않는다", () => {
    expect(parseStyle("비키니 엣지").matched).not.toContain("비키니");
  });
});

describe("NSFW 묘사를 편집 스타일 값에도 반영", () => {
  it("성적 묘사만 적으면 느리고 부드러운 결로 편집한다", () => {
    const style = parseStyle("nsfw, 섹시한 비키니");
    expect(style.mood).toBe("emotional");
    expect(style.grade).toBe("warm");
    expect(style.effects.has("slowmo")).toBe(true);
    expect(style.effects.has("zoom")).toBe(true);
    expect(style.transition).toBe("fade");
    expect(style.look?.glow).toBeGreaterThanOrEqual(0.5);
    expect(style.look?.saturation).toBeGreaterThan(1);
  });

  it("직접 적은 분위기·색감이 성적 묘사보다 먼저다", () => {
    const style = parseStyle("nsfw 섹시, 빠른 비트, 흑백");
    expect(style.mood).toBe("hype");
    expect(style.grade).toBe("mono");
  });

  it("빼 달라고 한 효과는 성적 묘사로도 넣지 않는다", () => {
    // 하이프(빠른 비트)에 성적 묘사를 더하면 느린 화면이 붙지만, 빼 달라고 했으면 붙이지 않습니다.
    expect(parseStyle("nsfw 섹시, 빠른 비트, 슬로모션 없이").effects.has("slowmo")).toBe(false);
    expect(parseStyle("nsfw 섹시, 빠른 비트, 효과 없이").effects.has("slowmo")).toBe(false);
  });

  it("NSFW 표시가 없으면 편집 스타일 값은 예전 그대로다", () => {
    const style = parseStyle("섹시한 비키니");
    expect(style.mood).toBe("hype");
    expect(style.grade).toBe("vivid");
    expect(style.effects.has("slowmo")).toBe(false);
    expect(style.transition).toBeUndefined();
    expect(style.look).toBeUndefined();
  });
});
