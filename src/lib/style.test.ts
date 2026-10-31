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
