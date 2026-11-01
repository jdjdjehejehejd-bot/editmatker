import { describe, expect, it } from "vitest";
import { pickHighlights, scoreSamples, type FrameSample } from "./highlights";
import { AFTER_HIT, buildPlan, velocitySource } from "./plan";
import { detectSport } from "./sport";
import { parseStyle } from "./style";

const weights = parseStyle("").weights;
const make = (length: number, fn: (t: number) => Partial<FrameSample>): FrameSample[] =>
  Array.from({ length }, (_, i) => {
    const t = i * 0.25;
    return { t, motion: 0.03, action: 0.01, audio: 0.2, color: 0.4, brightness: 0.5, cut: false, detail: 0.05, ...fn(t) };
  });

describe("종목 알아보기", () => {
  it("주제 설명·제목으로 종목을 알아봄", () => {
    expect(detectSport("시릴 가네", "French mixed martial artist", "[UFC] 알렉스 페레이라 vs 시릴 간")).toBe("combat");
    expect(detectSport("손흥민", "South Korean footballer")).toBe("ball");
    expect(detectSport("NBA dunk contest")).toBe("ball");
    expect(detectSport("F1 Monaco onboard")).toBe("racing");
    expect(detectSport("도쿄 야경")).toBeNull();
  });
});

describe("종목별 핵심 순간", () => {
  it("격투기: 한 번 튀는 구간보다 연타가 들어간 구간", () => {
    // 10초에 한 방, 20~21초에 세 방(콤보) — 크기는 같음
    const hit = (t: number) => [10, 20, 20.75, 21.5].some(h => Math.abs(t - h) < 0.1);
    const samples = make(120, t => (hit(t) ? { motion: 0.2, action: 0.18, audio: 0.6 } : {}));
    const scores = scoreSamples(samples, weights);
    const [best] = pickHighlights("a", samples, scores, 3, 1, 30, { sport: "combat" });
    expect(best.start).toBeGreaterThan(17);
    expect(best.peak).toBeGreaterThanOrEqual(20);
    expect(best.accent).toBe(true);
  });

  it("구기: 슛 뒤 함성이 커지는 구간을 고름(같은 크기의 튀는 순간이 두 번이어도)", () => {
    // 8초 슛 뒤 조용, 20초 슛 뒤 함성이 점점 커짐
    const samples = make(120, t => {
      if (Math.abs(t - 8) < 0.1 || Math.abs(t - 20) < 0.1) return { motion: 0.2, action: 0.18, audio: 0.5 };
      if (t > 20 && t < 23) return { audio: 0.3 + (t - 20) * 0.2 };
      return {};
    });
    const scores = scoreSamples(samples, weights);
    const [best] = pickHighlights("a", samples, scores, 3, 1, 30, { sport: "ball" });
    expect(best.peak).toBeCloseTo(20, 0);
  });

  it("레이싱: 카메라가 빠르게 따라가는 구간을 살림", () => {
    // 0~12초: 카메라 정지, 12~24초: 빠르게 따라감(화면 전체 움직임 큼, 실제 동작은 작음)
    const samples = make(120, t => (t >= 12 && t < 24 ? { motion: 0.15, action: 0.012 } : { motion: 0.01, action: 0.012 }));
    const racing = pickHighlights("a", samples, scoreSamples(samples, weights, 0, undefined, { cameraMotion: true }), 3, 1, 30, { sport: "racing" })[0];
    expect(racing.start).toBeGreaterThanOrEqual(11);
    expect(racing.start).toBeLessThan(24);
  });

  it("스포츠가 아니면 예전과 같음", () => {
    const samples = make(120, t => (Math.abs(t - 15) < 0.1 ? { motion: 0.2, action: 0.18, audio: 0.6 } : {}));
    const scores = scoreSamples(samples, weights);
    const plain = pickHighlights("a", samples, scores, 3, 2, 30);
    expect(plain.every(h => !h.accent)).toBe(true);
  });
});

describe("결정적 순간 강조", () => {
  it("컷 안에서 그 순간이 언제 오는지 계획에 담음", () => {
    const plan = buildPlan({ highlights: [{ sourceId: "a", start: 20, length: 4, score: 1, peak: 22, accent: true }], style: parseStyle(""), totalSeconds: 8 });
    const hits = plan.segments.filter(s => s.hitAt !== undefined);
    expect(hits.length).toBeGreaterThan(0);
    for (const s of hits) {
      expect(s.hitAt!).toBeGreaterThan(0);
      expect(s.hitAt!).toBeLessThan(s.duration);
      // 벨로시티 컷은 재생 속도가 바뀌므로 그만큼 거꾸로 맞춤
      const shown = s.velocity ? velocitySource(s.hitAt! / s.duration) * s.duration : s.hitAt! * s.rate;
      expect(s.srcStart + shown).toBeCloseTo(22, 3);
    }
    // 강조 표시가 없는 장면에는 넣지 않음
    expect(buildPlan({ highlights: [{ sourceId: "a", start: 20, length: 4, score: 1, peak: 22 }], style: parseStyle(""), totalSeconds: 8 }).segments.some(s => s.hitAt !== undefined)).toBe(false);
  });
});

describe("맞는 순간이 컷 안에", () => {
  it("짧은 컷·다시 쓰는 장면에서도 임팩트가 컷 안에 있고 그 뒤 반응이 남음", () => {
    const highlights = [
      { sourceId: "a", start: 20, length: 4, score: 1, peak: 22.6, accent: true },
      { sourceId: "b", start: 40, length: 4, score: 0.9, peak: 41.6, accent: true },
    ];
    // 장면이 두 개뿐이라 대부분 다시 쓰임
    const plan = buildPlan({ highlights, style: parseStyle("빠르게 강렬한 격투기"), totalSeconds: 20 });
    for (const s of plan.segments) {
      const h = highlights.find(x => x.sourceId === s.sourceId)!;
      const span = s.velocity ? velocitySource(1) * s.duration : s.duration * s.rate;
      const offset = h.peak - s.srcStart;
      if (h.length - s.duration * s.rate <= 0) continue;
      expect(offset).toBeGreaterThan(0);
      // 맞은 뒤 AFTER_HIT초(짧은 컷은 컷의 절반 남짓)가 남음
      expect(span - offset).toBeGreaterThanOrEqual(Math.min(AFTER_HIT, span * 0.55) - 1e-6);
    }
  });
});
