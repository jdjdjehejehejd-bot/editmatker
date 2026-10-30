import { describe, expect, it } from "vitest";
import { loadPresets, matchesPreset, sanitizePreset, savePresets, upsertPreset, type PresetSettings } from "./presets";

const settings: PresetSettings = { topic: "손흥민, 3:케인:", features: "골 장면", seconds: 15, aspect: "9:16", sourceCount: 3, licenseMode: "any" };

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("프리셋", () => {
  it("저장하고 다시 불러온다", () => {
    const storage = memoryStorage();
    const list = upsertPreset([], "토트넘 듀오", settings, 1);
    savePresets(list, storage);
    expect(loadPresets(storage)).toEqual([{ id: "preset-1", name: "토트넘 듀오", ...settings, musicStyle: "auto" }]);
  });

  it("같은 이름은 덮어쓰고, 새 이름은 맨 앞에 추가한다", () => {
    let list = upsertPreset([], "A", settings, 1);
    list = upsertPreset(list, "B", { ...settings, topic: "뉴진스" }, 2);
    list = upsertPreset(list, "A", { ...settings, seconds: 60 }, 3);
    expect(list.map(p => [p.name, p.id, p.seconds])).toEqual([
      ["B", "preset-2", 15],
      ["A", "preset-1", 60],
    ]);
  });

  it("기본 프리셋은 저장하지 않는다", () => {
    const storage = memoryStorage();
    savePresets([{ id: "x", name: "기본", builtin: true, ...settings }], storage);
    expect(loadPresets(storage)).toEqual([]);
  });

  it("깨진 저장값은 무시하고 이상한 설정은 기본값으로 고친다", () => {
    expect(loadPresets({ getItem: () => "not json" })).toEqual([]);
    expect(sanitizePreset({ name: "x", topic: "" })).toBeNull();
    expect(sanitizePreset({ id: "p", name: "x", topic: "고양이", seconds: 999, aspect: "4:3", sourceCount: 50, licenseMode: "??" })).toMatchObject({ seconds: 30, aspect: "9:16", sourceCount: 4, licenseMode: "any" });
  });

  it("지금 입력과 같은 프리셋을 알아본다", () => {
    const [preset] = upsertPreset([], "A", settings, 1);
    expect(matchesPreset(preset, settings)).toBe(true);
    expect(matchesPreset(preset, { ...settings, aspect: "1:1" })).toBe(false);
  });
});

describe("배경음악 스타일", () => {
  it("프리셋에 저장되고, 예전 프리셋은 자동으로 읽는다", () => {
    const [preset] = upsertPreset([], "A", { ...settings, musicStyle: "retro" }, 1);
    expect(preset.musicStyle).toBe("retro");
    expect(sanitizePreset({ name: "old", topic: "고양이" })?.musicStyle).toBe("auto");
    expect(sanitizePreset({ name: "x", topic: "고양이", musicStyle: "jazz" })?.musicStyle).toBe("auto");
    expect(matchesPreset(preset, { ...settings, musicStyle: "hype" })).toBe(false);
  });
});
