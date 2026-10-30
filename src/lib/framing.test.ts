import { describe, expect, it } from "vitest";
import { cropOffset, focusAt, interestPoint, isSkin, smoothTrack } from "./framing";

/** w×h 프레임을 만들고, (x0..x1) 열에 피부색 사람을 그립니다. */
function frame(w: number, h: number, x0: number, x1: number) {
  const pixels: number[] = [];
  const luma: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const person = x >= x0 && x <= x1;
      const [r, g, b] = person ? [210, 150, 120] : [40, 80, 60];
      pixels.push(r, g, b, 255);
      luma.push((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
    }
  return { pixels, luma };
}

describe("자동 리프레이밍", () => {
  it("피부색을 알아본다", () => {
    expect(isSkin(210, 150, 120)).toBe(true);
    expect(isSkin(40, 80, 60)).toBe(false);
    expect(isSkin(200, 200, 200)).toBe(false);
  });

  it("사람이 오른쪽에 있으면 관심 지점도 오른쪽", () => {
    const { pixels, luma } = frame(64, 36, 48, 56);
    const focus = interestPoint(pixels, luma, null, 64, 36);
    expect(focus.x).toBeGreaterThan(0.75);
    expect(focus.x).toBeLessThan(0.9);
    expect(focus.presence).toBeCloseTo(9 / 64, 2);
  });

  it("움직임이 있는 곳으로 끌려간다", () => {
    const still = frame(64, 36, -1, -1);
    const moved = still.luma.map((l, j) => (j % 64 < 10 ? l + 0.5 : l));
    const focus = interestPoint(still.pixels, moved, still.luma, 64, 36);
    expect(focus.x).toBeLessThan(0.2);
  });

  it("볼거리가 없으면 가운데", () => {
    const { pixels, luma } = frame(64, 36, -1, -1);
    expect(interestPoint(pixels, luma, luma, 64, 36)).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("경로를 부드럽게 하고 사이 시각을 이어 준다", () => {
    const smooth = smoothTrack([{ t: 0, x: 0, y: 0.5 }, { t: 0.5, x: 1, y: 0.5 }, { t: 3, x: 1, y: 0.5 }]);
    expect(smooth[0].x).toBeCloseTo(0.5);
    expect(focusAt([{ t: 0, x: 0, y: 0 }, { t: 2, x: 1, y: 1 }], 1)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("가로 영상을 세로 화면에 자를 때 사람 쪽으로 옮기되 영상 밖은 보이지 않게", () => {
    // 1280px 너비로 그린 영상을 720px 화면에: 가운데 자르기는 -280
    expect(cropOffset(0.5, 1280, 720)).toBe(-280);
    expect(cropOffset(0.6, 1280, 720)).toBeCloseTo(-408); // 360 - 0.6×1280
    expect(cropOffset(1, 1280, 720)).toBe(-560); // 오른쪽 끝에서 멈춤
    expect(cropOffset(0, 1280, 720)).toBe(0); // 왼쪽 끝에서 멈춤
  });
});
