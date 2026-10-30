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
