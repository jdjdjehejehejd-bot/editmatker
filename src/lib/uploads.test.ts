import { describe, expect, it } from "vitest";
import { sanitizeWeight, uploadGroupWeight, uploadKey, uploadShares } from "./uploads";

describe("올린 영상 가중치", () => {
  it("×1은 찾은 영상 하나와 같은 비중", () => {
    // 찾을 영상 4개 + 올린 영상 2개, 모두 ×1 → 영상마다 1/6
    const shares = uploadShares([1, 1], 4);
    expect(shares[0]).toBeCloseTo(1 / 6);
    expect(shares[1]).toBeCloseTo(1 / 6);
    // 주제 비중 1을 찾은 영상 4개가 나눠 가지면 하나가 0.25 → 올린 영상 2개는 0.5
    expect(uploadGroupWeight(1, [1, 1], 4)).toBeCloseTo(0.5);
  });

  it("×2는 찾은 영상 하나의 2배", () => {
    const shares = uploadShares([2, 1], 4);
    expect(shares[0]).toBeCloseTo(2 / 7);
    expect(shares[1]).toBeCloseTo(1 / 7);
    expect(uploadGroupWeight(1, [2, 1], 4)).toBeCloseTo(0.75);
  });

  it("올린 영상만 쓰면 올린 영상끼리만 나눔", () => {
    expect(uploadShares([4, 1], 0)).toEqual([0.8, 0.2]);
    expect(uploadShares([2, 2], 0)).toEqual([0.5, 0.5]);
    expect(uploadGroupWeight(0, [5], 0)).toBe(1);
    expect(uploadGroupWeight(1, [], 4)).toBe(0);
  });

  it("잘못된 값은 ×1~×5로", () => {
    expect(sanitizeWeight("9")).toBe(5);
    expect(sanitizeWeight(0)).toBe(1);
    expect(sanitizeWeight(undefined)).toBe(1);
    expect(uploadKey({ name: "a.mp4", size: 10 })).toBe("a.mp4:10");
  });
});
