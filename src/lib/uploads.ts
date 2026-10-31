// 직접 올린 영상의 가중치. 파일마다 ×1~×5로 정하면 그만큼 더 자주(길게) 나옵니다.
// ×1은 "찾은 영상 하나와 같은 비중"입니다. 예: 찾을 영상 4개 + 올린 영상 2개가 모두 ×1이면 영상마다 약 17%.
// (예전에는 올린 영상 전체가 늘 절반이라, 같은 ×1인데도 올린 영상 하나가 찾은 영상보다 2배씩 나왔습니다.)

export const UPLOAD_WEIGHTS = [1, 2, 3, 4, 5] as const;

/** 같은 파일을 알아보는 열쇠 (다시 골라도 가중치가 유지되게) */
export function uploadKey(file: { name: string; size: number }) {
  return `${file.name}:${file.size}`;
}

export function sanitizeWeight(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
}

/**
 * 찾은 영상과 섞을 때 올린 영상 전체의 비중(주제 비중과 같은 단위).
 * 찾은 영상 하나의 비중(= 찾은 영상들 비중 합 ÷ 찾은 영상 수)에 올린 파일 가중치의 합을 곱합니다.
 * 찾은 영상이 없으면(올린 영상만) 1.
 */
export function uploadGroupWeight(onlineWeight: number, weights: number[], onlineCount: number): number {
  if (!weights.length) return 0;
  if (onlineWeight <= 0 || onlineCount <= 0) return 1;
  const sum = weights.reduce((total, w) => total + sanitizeWeight(w), 0);
  return (onlineWeight * sum) / onlineCount;
}

/** 파일마다 편집에서 차지할 대략의 비율 (0~1). onlineCount: 함께 쓸 찾은 영상 수(섞지 않으면 0) */
export function uploadShares(weights: number[], onlineCount: number): number[] {
  const clean = weights.map(sanitizeWeight);
  const total = clean.reduce((a, b) => a + b, 0) + Math.max(0, onlineCount);
  return clean.map(w => w / (total || 1));
}
