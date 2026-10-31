import { describe, expect, it } from "vitest";
import { isAudioMediaUrl } from "../../api/_stock";
import { licenseName, parseOpenverse, trackCredit } from "./freemusic";

describe("무료 음악 (Openverse)", () => {
  const data = {
    results: [
      { id: "a", title: "Epic Rise", creator: "Kim", url: "http://ccmixter.org/content/kim/epic.mp3", foreign_landing_url: "https://ccmixter.org/files/kim/1", license: "by", license_version: "4.0", duration: 180000, source: "ccmixter" },
      { id: "b", title: "Too Short", creator: "Lee", url: "https://cdn.freesound.org/previews/1/short.mp3", license: "cc0", duration: 8000, source: "freesound" },
      { id: "c", title: "No Edit", creator: "Park", url: "https://prod-1.storage.jamendo.com/?trackid=1", license: "by-nd", duration: 200000, source: "jamendo" },
      { id: "d", title: "", creator: "", url: "https://prod-1.storage.jamendo.com/?trackid=2", license: "by-nc-sa", license_version: "3.0", duration: null, source: "jamendo" },
      { id: "e", title: "Hour Mix", url: "https://cdn.freesound.org/x.mp3", license: "pdm", duration: 3600000 },
    ],
  };

  it("편집 길이보다 짧은 곡·변경 금지(ND)·너무 긴 곡은 빼고 https로 받음", () => {
    const tracks = parseOpenverse(data, 33);
    expect(tracks.map(t => t.id)).toEqual(["openverse:a", "openverse:d"]);
    expect(tracks[0]).toMatchObject({ title: "Epic Rise", url: "https://ccmixter.org/content/kim/epic.mp3", license: "CC BY 4.0", duration: 180, provider: "ccmixter" });
    expect(tracks[1]).toMatchObject({ title: "Untitled", creator: "Unknown", license: "CC BY-NC-SA 3.0", duration: null });
  });

  it("라이선스 표기와 출처 한 줄", () => {
    expect(licenseName("cc0", "1.0")).toBe("CC0");
    expect(licenseName("pdm", "")).toBe("Public domain");
    expect(trackCredit(parseOpenverse(data, 33)[0])).toBe('Music: "Epic Rise" — Kim · CC BY 4.0 · ccmixter');
  });

  it("음원 서버만 프록시", () => {
    expect(isAudioMediaUrl("https://prod-1.storage.jamendo.com/?trackid=1&format=mp31")).toBe(true);
    expect(isAudioMediaUrl("https://cdn.freesound.org/previews/1/a.mp3")).toBe(true);
    expect(isAudioMediaUrl("https://ccmixter.org/content/a.mp3")).toBe(true);
    expect(isAudioMediaUrl("https://jamendo.com.evil.example/a.mp3")).toBe(false);
    expect(isAudioMediaUrl("http://cdn.freesound.org/a.mp3")).toBe(false);
  });
});

describe("무료 음악이 매번 같지 않게", () => {
  const track = (id: string) => ({ id, title: id, creator: "x", url: `https://cdn.freesound.org/${id}.mp3`, pageUrl: "", license: "CC0", licenseUrl: null, duration: 60, provider: "freesound" });

  it("최근에 쓴 곡은 뒤로, 오래전에 쓴 곡이 그다음", async () => {
    const { orderTracks } = await import("./freemusic");
    const order = orderTracks([track("a"), track("b"), track("c"), track("d")], ["b", "d"], () => 0.5).map(t => t.id);
    expect(order.slice(0, 2).sort()).toEqual(["a", "c"]);
    expect(order.slice(2)).toEqual(["d", "b"]); // d가 b보다 오래전에 씀
  });

  it("쓴 곡을 기억함 (최근 30곡)", async () => {
    const { loadRecentTracks, rememberTrack } = await import("./freemusic");
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    for (let i = 0; i < 35; i++) rememberTrack(`t${i}`, storage);
    rememberTrack("t34", storage);
    const recent = loadRecentTracks(storage);
    expect(recent).toHaveLength(30);
    expect(recent[0]).toBe("t34");
    expect(recent.filter(id => id === "t34")).toHaveLength(1);
  });
});
