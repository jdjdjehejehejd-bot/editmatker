import { describe, expect, it } from "vitest";
import { addSimilarity, centroid, cosine, rerankBySimilarity } from "./similarity";

describe("장면 닮은 정도", () => {
  it("코사인과 평균 방향", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    const c = centroid([[2, 0], [0, 2]])!;
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(centroid([])).toBeNull();
  });

  it("닮은 후보를 앞당기되 원래 순서를 크게 흔들지 않음", () => {
    const items = ["a", "b", "c", "d"];
    const sims: Record<string, number | null> = { a: 0.2, b: 0.21, c: 0.9, d: null };
    expect(rerankBySimilarity(items, item => sims[item])).toEqual(["c", "d", "a", "b"]); // 모르는 d는 평균(0.44)
    // 모르는 후보가 가장 닮은 후보를 앞지르지 않음
    expect(rerankBySimilarity(["u", "p", "x"], item => ({ u: null, p: 0.3, x: 0.9 })[item] ?? null)[0]).toBe("x");
    // 거의 같으면 원래 순서
    expect(rerankBySimilarity(["x", "y"], item => (item === "x" ? 0.5 : 0.505))).toEqual(["x", "y"]);
    // 아무것도 모르면 그대로
    expect(rerankBySimilarity(items, () => null)).toEqual(items);
  });

  it("닮은 장면 근처 샘플 점수를 올림", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ t: i, motion: 0, audio: 0, color: 0, brightness: 0.5, cut: false }));
    const scores = addSimilarity(Array(10).fill(0.5), samples, [1, 8], [0.1, 0.9]);
    expect(scores[8]).toBeCloseTo(0.75);
    expect(scores[1]).toBeCloseTo(0.5);
    expect(scores[9]).toBeGreaterThan(scores[2]);
    expect(addSimilarity([1], samples.slice(0, 1), [], [])).toEqual([1]);
  });
});
