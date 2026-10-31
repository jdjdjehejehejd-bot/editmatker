import { describe, expect, it } from "vitest";
import { sanitizeWeight, uploadGroupWeight, uploadKey, uploadShares } from "./uploads";

describe("올린 영상 가중치", () => {
  it("모두 ×1이면 찾은 영상과 반반 (예전과 같음)", () => {
    expect(uploadGroupWeight(1, [1, 1])).toBe(1);
    expect(uploadGroupWeight(3, [1])).toBe(3);
    const shares = uploadShares([1, 1], 1, true);
    expect(shares[0] + shares[1]).toBeCloseTo(0.5);
  });

  it("가중치를 올리면 그 파일이 더 자주, 올린 영상 쪽 비중도 커짐", () => {
    const shares = uploadShares([3, 1], 1, true);
    expect(shares[0]).toBeCloseTo(shares[1] * 3);
    expect(shares[0] + shares[1]).toBeCloseTo(2 / 3); // 평균 ×2 → 2:1
  });

  it("올린 영상만 쓰면 올린 영상끼리만 나눔", () => {
    expect(uploadShares([4, 1], 1, false)).toEqual([0.8, 0.2]);
    expect(uploadShares([2, 2], 0, true)).toEqual([0.5, 0.5]);
    expect(uploadGroupWeight(0, [5])).toBe(1);
  });

  it("잘못된 값은 ×1~×5로", () => {
    expect(sanitizeWeight("9")).toBe(5);
    expect(sanitizeWeight(0)).toBe(1);
    expect(sanitizeWeight(undefined)).toBe(1);
    expect(uploadKey({ name: "a.mp4", size: 10 })).toBe("a.mp4:10");
  });
});
