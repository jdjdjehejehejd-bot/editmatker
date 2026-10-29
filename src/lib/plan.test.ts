import { describe, expect, it } from "vitest";
import type { Highlight } from "./highlights";
import { buildPlan, interleaveBySource, requiredHighlightLength } from "./plan";
import { parseStyle } from "./style";

const highlights: Highlight[] = ["a", "b", "c"].flatMap(sourceId =>
  [0.9, 0.6, 0.3].map((score, i) => ({ sourceId, start: 10 + i * 20, length: 4, score: score - (sourceId === "a" ? 0 : 0.05) }))
);

describe("buildPlan", () => {
  it("요청한 길이를 박자 단위로 채운다", () => {
    const style = parseStyle("신나는 빠른 컷");
    const plan = buildPlan({ highlights, style, totalSeconds: 30 });
    const beat = 60 / plan.bpm;
    expect(Math.abs(plan.duration - 30)).toBeLessThan(beat * 4);
    for (const seg of plan.segments) {
      const beats = seg.duration / beat;
      expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-6);
    }
    // 이어 붙인 컷 사이에 빈틈이 없다
    plan.segments.forEach((seg, i) => {
      if (i) expect(seg.start).toBeCloseTo(plan.segments[i - 1].start + plan.segments[i - 1].duration);
    });
  });

  it("드롭 구간 첫 컷에 가장 좋은 장면을 쓰고 섹션 순서를 지킨다", () => {
    const style = parseStyle("");
    const plan = buildPlan({ highlights, style, totalSeconds: 30 });
    const firstDrop = plan.segments.find(s => s.section === "drop")!;
    expect(firstDrop.sourceId).toBe("a");
    expect(firstDrop.srcStart).toBe(10);
    expect(firstDrop.start).toBeCloseTo(plan.dropAt);
    const order = plan.segments.map(s => s.section).join(",");
    expect(order).toMatch(/^(intro,)+(drop,)+(outro,?)*$/);
  });

  it("같은 영상이 연달아 나오지 않게 섞는다", () => {
    const mixed = interleaveBySource(highlights);
    for (let i = 1; i < 3; i++) expect(mixed[i].sourceId).not.toBe(mixed[i - 1].sourceId);
  });

  it("사용자 음악의 박자 오프셋과 드롭을 반영한다", () => {
    const style = parseStyle("");
    const plan = buildPlan({ highlights, style, totalSeconds: 30, bpm: 120, beatOffset: 0.3, dropAt: 8.3 });
    expect(plan.dropAt).toBeCloseTo(8.3);
    expect(plan.segments[0].duration).toBeCloseTo(2 + 0.3);
  });

  it("슬로모션 스타일은 원본을 덜 소모한다", () => {
    const style = parseStyle("시네마틱 슬로우모션");
    const plan = buildPlan({ highlights, style, totalSeconds: 30 });
    expect(plan.segments.some(s => s.rate < 1)).toBe(true);
    expect(requiredHighlightLength(style)).toBeLessThanOrEqual(6);
  });

  it("하이라이트가 없으면 빈 계획", () => {
    expect(buildPlan({ highlights: [], style: parseStyle(""), totalSeconds: 15 }).segments).toEqual([]);
  });
});
