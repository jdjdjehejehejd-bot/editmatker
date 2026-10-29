import { describe, expect, it } from "vitest";
import { parseStyle } from "./style";

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
