import { describe, expect, it } from "vitest";
import { CATEGORIES, MIN_CONFIDENCE, topicFromFileNames, topicFromPredictions } from "./vision";

describe("파일 이름으로 주제 고르기", () => {
  it("카메라·앱이 붙인 이름은 무시", () => {
    expect(topicFromFileNames(["VID_20241030_123456.mp4", "KakaoTalk_20241030_1.mp4"])).toBeNull();
    expect(topicFromFileNames(["Screen_Recording_20240101-120000.mp4"])).toBeNull();
    expect(topicFromFileNames(["PXL_20240101_000000123.mp4", "IMG_1234 (2).MOV"])).toBeNull();
  });

  it("뜻있는 이름에서 장면 종류는 빼고 주제만", () => {
    expect(topicFromFileNames(["손흥민 골 장면.mp4"])).toBe("손흥민");
    expect(topicFromFileNames(["son heung min goal highlights.mp4"])).toBe("son heung min");
    expect(topicFromFileNames(["뉴진스_직캠_1.mp4", "뉴진스 무대 2.mp4", "random.mp4"])).toBe("뉴진스");
  });

  it("여러 파일에 공통된 말이 없으면 고르지 않음", () => {
    expect(topicFromFileNames(["tokyo.mp4", "paris.mp4", "london.mp4"])).toBeNull();
  });
});

describe("장면 분류로 주제 고르기", () => {
  const frame = (hot: Record<number, number>) => {
    const probs = new Float32Array(1000);
    for (const [i, p] of Object.entries(hot)) probs[Number(i)] = p;
    return probs;
  };

  it("품종이 달라도 같은 묶음(강아지)으로 더함", () => {
    const result = topicFromPredictions([frame({ 208: 0.4, 207: 0.3 }), frame({ 151: 0.5 }), frame({ 805: 0.2 })]);
    expect(result).toMatchObject({ term: "dog", label: "강아지", source: "vision" });
  });

  it("축구공이 많이 보이면 축구", () => {
    expect(topicFromPredictions([frame({ 805: 0.6 }), frame({ 805: 0.5, 978: 0.1 })])?.label).toBe("축구");
  });

  it("확신이 낮으면 고르지 않음", () => {
    expect(topicFromPredictions([frame({ 805: MIN_CONFIDENCE / 2 })])).toBeNull();
    expect(topicFromPredictions([])).toBeNull();
  });

  it("묶음끼리 분류 번호가 겹치지 않음", () => {
    const seen = new Set<number>();
    for (const category of CATEGORIES)
      for (const item of category.classes) {
        const [from, to] = Array.isArray(item) ? item : [item, item];
        for (let i = from; i <= to; i++) {
          expect(seen.has(i), `${category.term} ${i}`).toBe(false);
          seen.add(i);
        }
      }
  });
});
