import { describe, expect, it } from "vitest";
import type { FrameSample } from "./highlights";
import { applyProfile, buildProfile, countFlashes, shotLengths, statsFromPixels, type ReferenceAnalysis } from "./learn";
import { parseStyle } from "./style";

/** 컷 간격이 일정한 가짜 에딧: every초마다 장면 전환 */
function fakeEdit(duration: number, every: number, extra: Partial<FrameSample> = {}): FrameSample[] {
  const samples: FrameSample[] = [];
  for (let t = 0; t < duration; t += 0.1) {
    const cut = t > 0.05 && Math.abs((t + 1e-9) % every) < 0.05;
    samples.push({ t: +t.toFixed(2), motion: cut ? 0.5 : 0.02, audio: 0.3, color: 0.3, brightness: 0.5, cut, ...extra });
  }
  return samples;
}

const frame = (r: number, g: number, b: number, w = 4, h = 10, bars = false) => {
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) (bars && (y === 0 || y === h - 1) ? data.push(0, 0, 0, 255) : data.push(r, g, b, 255));
  return statsFromPixels(data, w, h);
};

describe("참고 에딧 분석", () => {
  it("장면 전환으로 샷 길이를 잰다", () => {
    const shots = shotLengths(fakeEdit(4, 0.5), 4);
    expect(shots.length).toBeGreaterThanOrEqual(7);
    expect(shots.slice(1, -1).every(s => Math.abs(s.length - 0.5) < 0.11)).toBe(true);
  });

  it("색 통계로 따뜻함·채도·레터박스를 읽는다", () => {
    expect(frame(220, 140, 80).warmth).toBeGreaterThan(0.3);
    expect(frame(128, 128, 128).saturation).toBe(0);
    expect(frame(200, 100, 60, 4, 10, true).letterbox).toBe(true);
    expect(frame(200, 100, 60).letterbox).toBe(false);
  });

  it("흰 화면 번쩍임을 센다", () => {
    const samples = fakeEdit(3, 1);
    samples[10].brightness = 0.95;
    samples[20].brightness = 0.95;
    expect(countFlashes(samples)).toBe(2);
  });

  it("빠른 컷 에딧에서 박자 패턴·템포·효과를 배운다", () => {
    const ref: ReferenceAnalysis = { title: "fast", duration: 20, samples: fakeEdit(20, 0.5), frames: [frame(220, 140, 80), frame(230, 150, 90)], bpm: 120 };
    const profile = buildProfile([ref], 140)!;
    expect(profile.bpm).toBe(120);
    // 120 BPM에서 0.5초 = 1박자
    expect(profile.cutBeats!.drop.every(b => b === 1)).toBe(true);
    expect(profile.grade).toBe("warm");
    expect(profile.addEffects).toEqual(expect.arrayContaining(["shake", "pulse", "velocity"]));
    expect(Math.abs(profile.averageShot - 0.5)).toBeLessThan(0.1);
  });

  it("느린 에딧은 슬로모션을 더하고 흔들림을 뺀다", () => {
    const ref: ReferenceAnalysis = { title: "slow", duration: 40, samples: fakeEdit(40, 4), frames: [frame(100, 100, 100)], bpm: 80 };
    const profile = buildProfile([ref], 140)!;
    expect(profile.addEffects).toContain("slowmo");
    expect(profile.removeEffects).toContain("shake");
    expect(profile.grade).toBe("mono");
  });

  it("배운 값을 스타일에 덮어쓰되 무드·검색 힌트는 둔다", () => {
    const style = parseStyle("신나는 골 장면");
    const profile = buildProfile([{ title: "x", duration: 20, samples: fakeEdit(20, 0.5), frames: [frame(220, 140, 80)], bpm: 128 }], style.bpm);
    const learned = applyProfile(style, profile);
    expect(learned.bpm).toBe(128);
    expect(learned.mood).toBe(style.mood);
    expect(learned.searchHints).toEqual(style.searchHints);
    expect(learned.grade).toBe("warm");
    expect(learned.label).toContain("참고 에딧 스타일");
    expect(applyProfile(style, null)).toBe(style);
  });

  it("컷이 거의 없거나 너무 짧은 영상은 리듬을 배우지 않는다", () => {
    expect(buildProfile([{ title: "x", duration: 3, samples: fakeEdit(3, 1), frames: [], bpm: null }], 140)).toBeNull();
    const still = buildProfile([{ title: "y", duration: 20, samples: fakeEdit(20, 100), frames: [], bpm: null }], 140)!;
    expect(still.cutBeats).toBeNull();
  });
});
