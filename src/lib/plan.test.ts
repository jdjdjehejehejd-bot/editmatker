import { describe, expect, it } from "vitest";
import type { Highlight } from "./highlights";
import { buildPlan, interleaveBySource, requiredHighlightLength } from "./plan";
import { applyOverrides, parseStyle } from "./style";

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

describe("가중 섞기", () => {
  it("비중이 3배인 영상이 3배 자주 나온다", () => {
    const many = (sourceId: string, weight: number) =>
      Array.from({ length: 20 }, (_, i) => ({ sourceId, start: i * 5, length: 4, score: 0.5, weight }));
    const order = interleaveBySource([...many("heavy", 0.75), ...many("light", 0.25)]).slice(0, 16);
    expect(order.filter(h => h.sourceId === "heavy")).toHaveLength(12);
    expect(order.filter(h => h.sourceId === "light")).toHaveLength(4);
  });
});

describe("자연스러운 전환", () => {
  it("무드에 맞는 전환과 벨로시티를 고른다", async () => {
    const { pickTransition } = await import("./plan");
    const hype = parseStyle("신나는");
    expect(pickTransition(hype, "drop", 0)).toBe("punch");
    expect(pickTransition(hype, "drop", 3)).toBe("whip");
    expect(pickTransition(hype, "intro", -1)).toBe("cut");
    expect(pickTransition(parseStyle("잔잔한 감성"), "drop", 0)).toBe("fade");
    expect(pickTransition(parseStyle("시네마틱"), "intro", -1)).toBe("fade");
    const plan = buildPlan({ highlights, style: hype, totalSeconds: 30 });
    expect(plan.segments[0].transition).toBe("cut");
    expect(plan.segments.some(s => s.velocity)).toBe(true);
    expect(plan.segments.filter(s => s.velocity).every(s => s.section === "drop" && s.rate === 1)).toBe(true);
  });
});

describe("직접 고른 전환", () => {
  it("모든 컷에 같은 전환을 씀", () => {
    const style = applyOverrides(parseStyle(""), { transition: "fade" });
    const plan = buildPlan({ highlights, style, totalSeconds: 30 });
    expect(plan.segments.slice(1).every(s => s.transition === "fade")).toBe(true);
  });
});

describe("비중과 장면 다시 쓰기", () => {
  it("장면이 모자라도 비중 큰 영상이 비중만큼 나옴 (다른 영상으로 채우지 않음)", () => {
    const make = (sourceId: string, weight: number) => [0, 1, 2].map(i => ({ sourceId, start: 10 + i * 10, length: 4, score: 0.9 - i * 0.1, weight }));
    const plan = buildPlan({ highlights: [...make("heavy", 0.8), ...make("light", 0.2)], style: parseStyle("빠른 컷"), totalSeconds: 30 });
    const seconds = (id: string) => plan.segments.filter(s => s.sourceId === id).reduce((sum, s) => sum + s.duration, 0);
    expect(plan.segments.length).toBeGreaterThan(6);
    expect(seconds("heavy")).toBeGreaterThan(seconds("light") * 2);
  });
});

describe("흐름", () => {
  const highlights = ["a", "b", "c"].flatMap(sourceId => [0, 1, 2].map(i => ({ sourceId, start: 10 + i * 10, length: 4, score: 0.9 - i * 0.1 })));
  it("점점 고조되게: 드롭이 늦고, 처음부터: 일찍, 기본은 1/4", () => {
    const at = (features: string) => {
      const plan = buildPlan({ highlights, style: parseStyle(features), totalSeconds: 30 });
      return plan.dropAt / plan.duration;
    };
    expect(at("점점 고조되게")).toBeGreaterThan(at(""));
    expect(at("처음부터 터지게")).toBeLessThan(at(""));
    expect(at("")).toBeCloseTo(0.25, 1);
  });

  it("여운 있게: 아웃트로가 길어짐", () => {
    const outro = (features: string) =>
      buildPlan({ highlights, style: parseStyle(features), totalSeconds: 30 })
        .segments.filter(s => s.section === "outro")
        .reduce((a, s) => a + s.duration, 0);
    expect(outro("여운 있게")).toBeGreaterThan(outro(""));
  });
});

describe("격투기 편집 계획", () => {
  const hs = Array.from({ length: 5 }, (_, i) => ({ sourceId: "a", start: i * 20, length: 4, score: 1 - i * 0.1 }));
  it("minCutBeats: 한 박자 컷 없이 모두 2박 이상", () => {
    const plan = buildPlan({ highlights: hs, style: parseStyle("빠르게 강렬한"), totalSeconds: 20, minCutBeats: 2 });
    const beat = 60 / plan.bpm;
    for (const s of plan.segments.slice(1)) expect(s.duration).toBeGreaterThanOrEqual(2 * beat - 1e-6);
  });

  it("quietCuts: 번쩍임은 구간이 바뀔 때만", () => {
    const style = parseStyle("빠르게 강렬한");
    if (!style.effects.has("flash")) style.effects.add("flash");
    const loud = buildPlan({ highlights: hs, style, totalSeconds: 20 });
    const quiet = buildPlan({ highlights: hs, style, totalSeconds: 20, quietCuts: true });
    expect(quiet.segments.filter(s => s.flash).length).toBeLessThan(loud.segments.filter(s => s.flash).length);
    expect(quiet.segments.filter(s => s.flash).length).toBeLessThanOrEqual(2);
  });

  it("장면을 다시 쓸 때 같은 순서 묶음이 통째로 반복되지 않음", () => {
    const pool = interleaveBySource(hs, 15);
    const order = pool.map(h => h.start);
    const blocks = [order.slice(0, 5).join(), order.slice(5, 10).join(), order.slice(10, 15).join()];
    expect(new Set(blocks).size).toBe(3);
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
  });
});
