// 장면끼리 얼마나 닮았는지: 이미지 분류 모델의 특징 벡터(512개 숫자)로 코사인 유사도를 잽니다.
// 브라우저 API에 의존하지 않는 순수 함수입니다.

import type { FrameSample } from "./highlights";

/** 벡터들의 평균 방향 (단위 벡터). 비어 있으면 null */
export function centroid(vectors: ArrayLike<number>[]): Float32Array | null {
  if (!vectors.length) return null;
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    const norm = Math.hypot(...Array.from(v)) || 1;
    for (let i = 0; i < out.length; i++) out[i] += v[i] / norm;
  }
  const norm = Math.hypot(...Array.from(out)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** 코사인 유사도 (-1~1) */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * 닮은 정도로 후보 순서를 다시 잡습니다. 원래 순서(관련도)를 크게 흔들지 않도록
 * 순위마다 조금씩(rankPenalty) 깎은 값에 닮은 정도를 더해 정렬합니다. 닮은 정도를 모르는 후보는 평균으로 봅니다.
 */
export function rerankBySimilarity<T>(items: T[], similarity: (item: T, index: number) => number | null, rankPenalty = 0.02): T[] {
  const sims = items.map(similarity);
  const known = sims.filter((s): s is number => s !== null);
  if (!known.length) return items;
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  return items
    .map((item, index) => ({ item, key: (sims[index] ?? mean) - index * rankPenalty }))
    .sort((a, b) => b.key - a.key)
    .map(entry => entry.item);
}

/**
 * 장면 점수에 "닮은 정도"를 더합니다. 닮은 정도는 몇 장면(키프레임)에서만 쟀으므로, 샘플마다 가장 가까운 키프레임 값을 씁니다.
 * 영상 안에서 상대적으로(가장 덜 닮은 장면 0 ~ 가장 닮은 장면 1) 맞춰서 weight만큼 더합니다.
 */
export function addSimilarity(scores: number[], samples: FrameSample[], keyTimes: number[], sims: number[], weight = 0.25): number[] {
  if (!keyTimes.length || keyTimes.length !== sims.length) return scores;
  const lo = Math.min(...sims);
  const hi = Math.max(...sims);
  if (hi - lo < 1e-6) return scores;
  return scores.map((score, i) => {
    const t = samples[i].t;
    let nearest = 0;
    for (let k = 1; k < keyTimes.length; k++) if (Math.abs(keyTimes[k] - t) < Math.abs(keyTimes[nearest] - t)) nearest = k;
    return score + weight * ((sims[nearest] - lo) / (hi - lo));
  });
}
