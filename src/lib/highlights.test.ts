import { describe, expect, it } from "vitest";
import { detectCuts, normalize, pickHighlights, scoreSamples, type FrameSample } from "./highlights";

const weights = { motion: 1, audio: 0.5, color: 0.3, stability: 0 };

function makeSamples(duration: number, step: number, hot: [number, number][]): FrameSample[] {
  const samples: FrameSample[] = [];
  for (let t = 0; t < duration; t += step) {
    const isHot = hot.some(([a, b]) => t >= a && t < b);
    samples.push({ t, motion: isHot ? 0.15 : 0.02, audio: isHot ? 0.6 : 0.1, color: 0.3, brightness: 0.5, cut: false });
  }
  return samples;
}

describe("highlights", () => {
  it("normalize는 0~1 범위로 맞춘다", () => {
    const values = normalize([0, 5, 10]);
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(1);
    expect(normalize([3, 3, 3])).toEqual([0, 0, 0]);
  });

  it("급격한 픽셀 변화를 장면 전환으로 감지한다", () => {
    expect(detectCuts([0.02, 0.03, 0.02, 0.5, 0.03, 0.02])).toEqual([false, false, false, true, false, false]);
  });

  it("움직임과 소리가 큰 구간을 겹치지 않게 고른다", () => {
    const samples = makeSamples(60, 0.5, [[10, 14], [40, 44]]);
    const scores = scoreSamples(samples, weights);
    const picks = pickHighlights("s", samples, scores, 3, 2, 60);
    expect(picks).toHaveLength(2);
    const starts = picks.map(p => p.start).sort((a, b) => a - b);
    expect(starts[0]).toBeGreaterThanOrEqual(10);
    expect(starts[0]).toBeLessThanOrEqual(11);
    expect(starts[1]).toBeGreaterThanOrEqual(40);
    expect(starts[1]).toBeLessThanOrEqual(41);
  });

  it("검은 화면은 점수를 크게 깎는다", () => {
    const samples = makeSamples(10, 1, [[3, 8]]);
    samples[5].brightness = 0.02;
    const scores = scoreSamples(samples, weights);
    expect(scores[5]).toBeLessThan(scores[4] * 0.5);
  });
});
