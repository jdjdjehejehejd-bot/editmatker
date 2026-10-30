import { describe, expect, it } from "vitest";
import { DEFAULT_OVERLAY, MAX_TEXTS, renderableTexts, sanitizeOverlay, textAlpha, textAnchorY } from "./overlay";
import { matchesPreset, sanitizePreset, type PresetSettings } from "./presets";

describe("오버레이 설정", () => {
  it("예전 값·잘못된 값은 기본값으로", () => {
    expect(sanitizeOverlay(undefined)).toEqual(DEFAULT_OVERLAY);
    const value = sanitizeOverlay({ showTitle: false, title: 7, showCredits: false, texts: [{ text: "안녕", start: -3, duration: 999, position: "side", size: "huge" }, { nope: 1 }] });
    expect(value).toEqual({ showTitle: false, title: "", showCredits: false, texts: [{ text: "안녕", start: 0, duration: 60, position: "bottom", size: "medium" }] });
    expect(sanitizeOverlay({ texts: Array.from({ length: 20 }, () => ({ text: "a" })) }).texts).toHaveLength(MAX_TEXTS);
  });

  it("빈 텍스트·영상 뒤에 시작하는 텍스트는 빼고, 길이는 영상 안으로", () => {
    const texts = renderableTexts(
      [
        { text: "  ", start: 0, duration: 2, position: "top", size: "small" },
        { text: " 골! ", start: 9, duration: 5, position: "center", size: "large" },
        { text: "늦음", start: 12, duration: 1, position: "bottom", size: "medium" },
      ],
      10
    );
    expect(texts).toEqual([{ text: "골!", start: 9, duration: 1, position: "center", size: "large" }]);
  });

  it("앞뒤로 페이드", () => {
    const text = { text: "a", start: 1, duration: 2, position: "bottom" as const, size: "medium" as const };
    expect(textAlpha(text, 0.5)).toBe(0);
    expect(textAlpha(text, 1.1)).toBeCloseTo(0.4);
    expect(textAlpha(text, 2)).toBe(1);
    expect(textAlpha(text, 3.5)).toBe(0);
    expect(textAnchorY("top")).toBeLessThan(textAnchorY("center"));
  });

  it("프리셋에 저장·비교", () => {
    const settings: PresetSettings = { topic: "a", features: "", seconds: 15, aspect: "9:16", sourceCount: 3, licenseMode: "any", overlay: { ...DEFAULT_OVERLAY, title: "내 제목" } };
    const preset = sanitizePreset({ id: "p", name: "p", ...settings })!;
    expect(preset.overlay?.title).toBe("내 제목");
    expect(matchesPreset(preset, settings)).toBe(true);
    expect(matchesPreset(preset, { ...settings, overlay: DEFAULT_OVERLAY })).toBe(false);
    expect(matchesPreset(sanitizePreset({ id: "q", name: "q", ...settings, overlay: undefined })!, { ...settings, overlay: DEFAULT_OVERLAY })).toBe(true);
  });
});
