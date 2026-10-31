// 직접 올린 영상의 가중치. 파일마다 ×1~×5로 정하면 그만큼 더 자주(길게) 나옵니다.
// 찾은 영상과 섞을 때 올린 영상 전체의 비중은 "주제 비중 합 × 파일 가중치 평균"이라,
// 모두 ×1이면 예전처럼 반반이고 가중치를 올리면 올린 영상 쪽이 커집니다.

export const UPLOAD_WEIGHTS = [1, 2, 3, 4, 5] as const;

/** 같은 파일을 알아보는 열쇠 (다시 골라도 가중치가 유지되게) */
export function uploadKey(file: { name: string; size: number }) {
  return `${file.name}:${file.size}`;
}

export function sanitizeWeight(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
}

/** 찾은 영상과 섞을 때 올린 영상 전체의 비중. 주제가 없으면(올린 영상만) 1 */
export function uploadGroupWeight(topicWeightSum: number, weights: number[]): number {
  if (!weights.length) return 0;
  if (topicWeightSum <= 0) return 1;
  const mean = weights.reduce((sum, w) => sum + sanitizeWeight(w), 0) / weights.length;
  return topicWeightSum * mean;
}

/** 파일마다 편집에서 차지할 대략의 비율 (0~1). mixing: 찾은 영상과 섞는지 */
export function uploadShares(weights: number[], topicWeightSum: number, mixing: boolean): number[] {
  const clean = weights.map(sanitizeWeight);
  const total = clean.reduce((a, b) => a + b, 0) || 1;
  const group = mixing && topicWeightSum > 0 ? uploadGroupWeight(topicWeightSum, clean) / (uploadGroupWeight(topicWeightSum, clean) + topicWeightSum) : 1;
  return clean.map(w => (group * w) / total);
}
