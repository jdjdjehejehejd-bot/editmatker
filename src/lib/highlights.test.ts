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

describe("인물 주제", () => {
  it("사람이 크게 보이는 순간의 점수를 높인다", () => {
    const samples = makeSamples(10, 1, []).map((s, i) => ({ ...s, presence: i === 6 ? 0.4 : 0.02 }));
    const plain = scoreSamples(samples, weights);
    const person = scoreSamples(samples, weights, 0.6);
    expect(plain[6]).toBeCloseTo(plain[5]);
    expect(person[6]).toBeGreaterThan(person[5]);
  });
});

describe("의미 없는 장면 거르기", () => {
  it("멈춘 화면·빈 화면 구간은 고르지 않고, 크게 떨어지는 구간으로 채우지 않음", async () => {
    const { pickHighlights, scoreSamples } = await import("./highlights");
    const { parseStyle } = await import("./style");
    // 0~20초: 움직이는 장면, 20~40초: 멈춘 자막 화면, 40~60초: 단색 화면
    const samples = Array.from({ length: 120 }, (_, i) => {
      const t = i * 0.5;
      const live = t < 20;
      return { t, motion: live ? 0.05 + 0.03 * Math.sin(i) : 0.001, audio: live ? 0.5 : 0.1, color: live ? 0.4 : 0.3, brightness: 0.5, cut: false, detail: t >= 40 ? 0.002 : 0.05 };
    });
    const scores = scoreSamples(samples, parseStyle("").weights);
    const picks = pickHighlights("a", samples, scores, 2, 10, 60);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every(p => p.start < 20)).toBe(true);
  });
});

describe("결정적 순간(임팩트)", () => {
  // 고요하다가 22초에 확 튀는(펀치) 영상
  const samples = Array.from({ length: 120 }, (_, i) => {
    const t = i * 0.25;
    const hit = Math.abs(t - 22) < 0.3;
    return { t, motion: hit ? 0.3 : 0.03 + 0.005 * Math.sin(i), audio: hit ? 0.9 : 0.2, color: 0.4, brightness: 0.5, cut: false, detail: 0.05 };
  });

  it("튀는 순간을 찾아 구간 가운데쯤 오게 잡음", async () => {
    const { impactSamples, pickHighlights, scoreSamples, PEAK_POSITION } = await import("./highlights");
    const { parseStyle } = await import("./style");
    const impact = impactSamples(samples);
    expect(samples[impact.indexOf(Math.max(...impact))].t).toBeCloseTo(22, 0);
    const [best] = pickHighlights("a", samples, scoreSamples(samples, parseStyle("").weights), 3, 3, 30);
    expect(best.peak).toBeCloseTo(22, 0);
    expect(best.start).toBeCloseTo(best.peak! - PEAK_POSITION * 3, 1);
  });

  it("편집에서 임팩트가 컷 안의 박자에 오게 시작점을 잡음", async () => {
    const { buildPlan } = await import("./plan");
    const { parseStyle } = await import("./style");
    const plan = buildPlan({ highlights: [{ sourceId: "a", start: 20, length: 4, score: 1, peak: 23.5 }], style: parseStyle(""), totalSeconds: 8 });
    const seg = plan.segments.find(s => s.section === "drop")!;
    const srcEnd = seg.srcStart + seg.duration * seg.rate;
    // 맞는 순간이 컷이 끝나기 전에, 컷 안에서 보임
    expect(seg.srcStart).toBeLessThanOrEqual(23.5);
    expect(srcEnd).toBeGreaterThan(23.5);
  });
});
