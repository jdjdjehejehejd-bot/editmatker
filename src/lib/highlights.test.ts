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

describe("카메라만 움직이는 장면", () => {
  it("카메라 이동을 빼면 걷기를 따라가는 화면은 작고, 화면 일부가 확 바뀌면 큼", async () => {
    const { residualMotion } = await import("./framing");
    const W = 64, H = 36;
    const scene = (shift: number, burst = false) => Float32Array.from({ length: W * H }, (_, j) => {
      const x = j % W, y = (j - x) / W;
      let v = 0.5 + 0.4 * Math.sin((x + shift) * 0.7) * Math.cos(y * 0.5);
      if (burst && x > 28 && x < 40 && y > 12 && y < 24) v = 1 - v;
      return v;
    });
    const pan = residualMotion(scene(2), scene(0), W, H);
    const hit = residualMotion(scene(0, true), scene(0), W, H);
    expect(pan).toBeLessThan(0.01);
    expect(hit).toBeGreaterThan(pan * 5);
  });

  it("스포츠: 결정적 순간이 없는 구간(걷기·세리머니)보다 있는 구간을 고름", async () => {
    const { pickHighlights, scoreSamples } = await import("./highlights");
    const { parseStyle } = await import("./style");
    // 0~15초: 카메라가 따라가는 걷기(전체 움직임 큼, 실제 동작 작음), 20초: 펀치
    const samples = Array.from({ length: 120 }, (_, i) => {
      const t = i * 0.25;
      const walking = t < 15;
      const punch = Math.abs(t - 20) < 0.3;
      return { t, motion: walking ? 0.12 : punch ? 0.2 : 0.03, action: walking ? 0.01 : punch ? 0.18 : 0.015, audio: punch ? 0.8 : 0.2, color: 0.4, brightness: 0.5, cut: false, detail: 0.05 };
    });
    const scores = scoreSamples(samples, parseStyle("").weights);
    const [best] = pickHighlights("a", samples, scores, 3, 1, 30, { preferImpact: true });
    expect(best.start).toBeGreaterThan(15);
    expect(best.peak).toBeCloseTo(20, 0);
  });
});

describe("특징 문장의 장면 선호로 점수", () => {
  it("어두운 장면·함성 장면을 원하면 그런 샘플이 높아짐", async () => {
    const { scoreSamples } = await import("./highlights");
    const samples = [
      { t: 0, motion: 0.05, audio: 0.2, color: 0.4, brightness: 0.8, cut: false },
      { t: 1, motion: 0.05, audio: 0.2, color: 0.4, brightness: 0.25, cut: false },
      { t: 2, motion: 0.05, audio: 0.9, color: 0.4, brightness: 0.5, cut: false },
    ];
    const weights = { motion: 1, audio: 0.5, color: 0.3, stability: 0 };
    const dark = scoreSamples(samples, weights, 0, { brightness: "dark" });
    expect(dark[1]).toBeGreaterThan(dark[0]);
    const bright = scoreSamples(samples, weights, 0, { brightness: "bright" });
    expect(bright[0]).toBeGreaterThan(bright[1]);
    const plain = scoreSamples(samples, weights);
    const loud = scoreSamples(samples, weights, 0, { loud: true });
    expect(loud[2] - loud[0]).toBeGreaterThan(plain[2] - plain[0]);
  });
});

describe("영상 전체가 살아 있는지", () => {
  const make = (motion: (i: number) => number, action?: (i: number) => number) =>
    Array.from({ length: 80 }, (_, i) => ({ t: i * 0.25, motion: motion(i), action: action?.(i), audio: 0.2, color: 0.4, brightness: 0.5, cut: false, detail: 0.05 }));

  it("사진 모음(거의 멈춤, 가끔 넘김)은 멈춘 영상으로", async () => {
    const { assessVideo } = await import("./highlights");
    const slideshow = make(i => (i % 16 === 0 ? 0.3 : 0.001), i => (i % 16 === 0 ? 0.3 : 0.001));
    const quality = assessVideo(slideshow);
    expect(quality.still).toBe(true);
    expect(quality.score).toBeLessThan(0.2);
  });

  it("카메라만 따라가는 영상은 낮게, 실제 동작이 많은 영상은 높게", async () => {
    const { assessVideo } = await import("./highlights");
    const panning = assessVideo(make(() => 0.1, () => 0.004));
    const action = assessVideo(make(() => 0.1, () => 0.04));
    expect(panning.still).toBe(false);
    expect(action.score).toBeGreaterThan(panning.score + 0.3);
    expect(action.score).toBeCloseTo(1, 1);
  });
});

describe("긴 영상: 볼 만한 곳만 촘촘히", () => {
  const base = (t: number, extra: Partial<FrameSample> = {}): FrameSample => ({ t, motion: 0.02, action: 0.01, audio: 0.1, color: 0.4, brightness: 0.5, cut: false, detail: 0.05, ...extra });
  it("pickRegions: 동작·소리가 튀는 곳을 겹치지 않게 고르고, 소리가 튄 시각을 가운데로", async () => {
    const { pickRegions } = await import("./highlights");
    const coarse = Array.from({ length: 40 }, (_, i) => base(i * 30 + 15, i === 10 ? { action: 0.2, motion: 0.2 } : i === 20 ? { action: 0.18, motion: 0.18 } : {}));
    const audioPeak = coarse.map((s, i) => ({ value: i === 30 ? 1 : 0.05, at: i === 30 ? s.t + 9 : s.t }));
    const regions = pickRegions(coarse, 1200, 5, 3, audioPeak);
    expect(regions).toHaveLength(3);
    const centers = regions.map(r => (r.from + r.to) / 2);
    expect(centers.some(c => Math.abs(c - 315) < 0.01)).toBe(true);
    expect(centers.some(c => Math.abs(c - 615) < 0.01)).toBe(true);
    // 함성(소리)은 결정타 뒤에 터지므로 1초 앞을 가운데로
    expect(centers.some(c => Math.abs(c - 923) < 0.01)).toBe(true);
    for (let i = 1; i < regions.length; i++) expect(regions[i].from).toBeGreaterThanOrEqual(regions[i - 1].to);
  });

  it("따로 본 구간을 넘나드는 장면은 만들지 않고, 임팩트를 구간 안에서 잡음", async () => {
    const { pickHighlights, scoreSamples, impactSamples } = await import("./highlights");
    const region = (from: number, punchAt: number | null) =>
      Array.from({ length: 26 }, (_, i) => {
        const t = from + i * 0.2;
        const hit = punchAt !== null && Math.abs(t - punchAt) < 0.05;
        return base(t, { gap: i === 0, ...(hit ? { action: 0.25, motion: 0.25, audio: 0.6 } : {}) });
      });
    const samples = [...region(100, null), ...region(400, 402.4), ...region(700, null)];
    // 구간 첫 샘플은 앞 구간과 비교하지 않음
    expect(impactSamples(samples)[26]).toBe(0);
    const picks = pickHighlights("a", samples, scoreSamples(samples, weights), 2, 3, 1200, { sport: "combat" });
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      const inside = [100, 400, 700].some(from => p.start >= from - 1e-6 && p.start + p.length <= from + 5 + 0.45 + 1e-6);
      expect(inside).toBe(true);
    }
    expect(picks[0].peak).toBeCloseTo(402.4, 5);
    expect(picks[0].start).toBeLessThan(402.4);
    expect(picks[0].start + picks[0].length).toBeGreaterThan(402.4 + 0.5);
  });
});

describe("계속되는 큰 움직임 vs 확 튀는 순간", () => {
  const base = (t: number, extra: Partial<FrameSample> = {}): FrameSample => ({ t, motion: 0.01, action: 0.01, audio: 0.1, color: 0.4, brightness: 0.5, cut: false, detail: 0.05, ...extra });
  it("카메라가 따라가며 계속 큰 움직임(입장 장면)보다 튀었다 가라앉는 펀치를 높게", async () => {
    const { impactSamples } = await import("./highlights");
    const samples = Array.from({ length: 60 }, (_, i) => {
      const t = i * 0.2;
      if (t >= 2 && t < 5) return base(t, { motion: 0.08, action: 0.08 }); // 계속
      if (Math.abs(t - 8) < 0.05) return base(t, { motion: 0.08, action: 0.08 }); // 한 번
      return base(t);
    });
    const impact = impactSamples(samples);
    const sustained = Math.max(...impact.slice(10, 25));
    const punch = impact[40];
    expect(punch).toBeGreaterThan(sustained * 1.8);
  });

  it("pickRegions: 절반은 영상 전체에 고르게 퍼뜨림(한 장면에 몰리지 않게)", async () => {
    const { pickRegions } = await import("./highlights");
    // 앞쪽(입장)에만 큰 움직임
    const coarse = Array.from({ length: 60 }, (_, i) => base(i * 10 + 5, i < 10 ? { action: 0.1 + i * 0.01, motion: 0.1 } : { action: 0.02, motion: 0.02 }));
    const regions = pickRegions(coarse, 600, 5, 6);
    expect(regions).toHaveLength(6);
    expect(regions.filter(r => r.from > 300).length).toBeGreaterThanOrEqual(2);
  });
});
