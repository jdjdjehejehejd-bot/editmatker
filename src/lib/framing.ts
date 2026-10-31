// 자동 리프레이밍: 원본 화면에서 "볼거리"(움직임·사람 피부색)가 몰린 곳을 찾아,
// 화면 비율을 바꿔 자를 때 가운데가 아니라 그 지점을 따라가도록 합니다.

export interface Focus {
  /** 관심 지점의 가로·세로 위치 (0~1) */
  x: number;
  y: number;
  /** 사람(피부색)이 화면을 차지하는 비율 (0~1) — 인물 주제에서 사람이 잘 보이는 장면을 고르는 데 씀 */
  presence: number;
}

/** 단순 RGB 피부색 규칙(조명·인종에 따라 완벽하지 않지만 가볍고 빠름) */
export function isSkin(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b;
}

/**
 * 작은 프레임(예: 64×36)의 관심 지점을 계산합니다.
 * 픽셀마다 움직임(이전 프레임과의 밝기 차)과 피부색에 가중치를 주어 무게중심을 구합니다.
 */
export function interestPoint(pixels: ArrayLike<number>, luma: ArrayLike<number>, previous: ArrayLike<number> | null, width: number, height: number): Focus {
  let total = 0;
  let sx = 0;
  let sy = 0;
  let skin = 0;
  for (let y = 0, j = 0; y < height; y++) {
    for (let x = 0; x < width; x++, j++) {
      const p = j * 4;
      const isPerson = isSkin(pixels[p], pixels[p + 1], pixels[p + 2]);
      if (isPerson) skin++;
      const motion = previous ? Math.abs(luma[j] - previous[j]) : 0;
      const weight = motion * 3 + (isPerson ? 0.6 : 0);
      total += weight;
      sx += weight * (x + 0.5);
      sy += weight * (y + 0.5);
    }
  }
  const presence = skin / (width * height);
  // 볼거리가 거의 없으면(정지·풍경) 가운데를 봅니다.
  if (total < width * height * 0.01) return { x: 0.5, y: 0.5, presence };
  return { x: sx / total / width, y: sy / total / height, presence };
}

/**
 * 카메라 이동을 뺀 움직임: 이전 프레임을 가로 ±3, 세로 ±2칸 밀어 보며 가장 잘 맞는 위치를 찾고,
 * 그 위치에서도 남는 밝기 차의 평균을 돌려줍니다(가장자리 여백은 빼고 비교).
 * 카메라만 따라가는 장면(걷기, 견제)은 작아지고, 주먹·발차기·슛처럼 화면 일부가 확 바뀌면 큽니다.
 */
export function residualMotion(luma: ArrayLike<number>, previous: ArrayLike<number>, width: number, height: number, maxDx = 3, maxDy = 2): number {
  let best = Infinity;
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    for (let dx = -maxDx; dx <= maxDx; dx++) {
      let sum = 0;
      let n = 0;
      for (let y = maxDy; y < height - maxDy; y++) {
        const row = y * width;
        const prevRow = (y + dy) * width + dx;
        for (let x = maxDx; x < width - maxDx; x++) {
          sum += Math.abs(luma[row + x] - previous[prevRow + x]);
          n++;
        }
        // 이미 지금까지의 최솟값보다 크면 더 볼 필요가 없습니다.
        if (sum > best * n * 1.05 && n > width) break;
      }
      const mean = sum / n;
      if (mean < best) best = mean;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

export interface FocusPoint {
  t: number;
  x: number;
  y: number;
}

/** 관심 지점을 시간에 따라 부드럽게 만듭니다(±window초 평균) — 카메라가 덜덜 떨지 않게. */
export function smoothTrack(points: FocusPoint[], window = 0.8): FocusPoint[] {
  // 시간순 점에 대해 창을 밀어 가며 합을 갱신합니다(점마다 전체를 다시 더하지 않음). 결과는 같습니다.
  const result: FocusPoint[] = [];
  let lo = 0;
  let hi = 0;
  let sx = 0;
  let sy = 0;
  for (const point of points) {
    while (hi < points.length && points[hi].t - point.t <= window) {
      sx += points[hi].x;
      sy += points[hi].y;
      hi++;
    }
    while (point.t - points[lo].t > window) {
      sx -= points[lo].x;
      sy -= points[lo].y;
      lo++;
    }
    const n = hi - lo;
    result.push({ t: point.t, x: sx / n, y: sy / n });
  }
  return result;
}

/** 시각 t의 관심 지점 (앞뒤 점 사이를 이어서) */
export function focusAt(track: FocusPoint[], t: number): { x: number; y: number } {
  if (!track.length) return { x: 0.5, y: 0.5 };
  if (t <= track[0].t) return track[0];
  if (t >= track[track.length - 1].t) return track[track.length - 1];
  // 렌더링 중 매 프레임 부르므로 처음부터 훑지 않고 이분 탐색으로 찾습니다.
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t < t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/**
 * 화면(view)보다 크게 그린 영상(drawn)에서, 관심 지점이 화면 가운데에 오도록 하는 위치.
 * 영상 가장자리 밖이 보이지 않게 [view - drawn, 0] 범위로 묶습니다.
 */
export function cropOffset(focus: number, drawn: number, view: number): number {
  // 영상이 화면보다 작으면(전체 보이기) 가운데에 둡니다.
  if (drawn <= view) return (view - drawn) / 2;
  const ideal = view / 2 - focus * drawn;
  return Math.min(0, Math.max(view - drawn, ideal));
}

/** 화면 맞추기: 자동(너무 많이 잘리면 일부만 자르고 나머지는 흐린 배경), 꽉 채우기(자르기), 전체 보이기 */
export type Framing = "auto" | "fill" | "fit";
export const FRAMING_LABEL: Record<Framing, string> = { auto: "자동", fill: "꽉 채우기", fit: "전체 보이기" };
/** 자동일 때 원본에서 최소한 보이게 할 비율 (가로·세로 각각) */
export const AUTO_KEEP = 0.6;

/**
 * 원본(sw×sh)을 화면(W×H)에 그릴 배율.
 * 자동: 꽉 채우면 원본의 60%도 안 보일 때(예: 가로 영상 → 세로 화면)만 덜 자르고, 남는 곳은 흐린 배경으로 채웁니다.
 * 덜 자르는 정도가 10% 안쪽이면 얇은 띠가 생기지 않게 그냥 꽉 채웁니다.
 */
export function frameScale(sw: number, sh: number, W: number, H: number, framing: Framing = "auto"): number {
  const cover = Math.max(W / sw, H / sh);
  const contain = Math.min(W / sw, H / sh);
  if (framing === "fill") return cover;
  if (framing === "fit") return contain;
  const limit = Math.min(W / (sw * AUTO_KEEP), H / (sh * AUTO_KEEP));
  const scale = Math.min(cover, Math.max(contain, limit));
  return scale >= cover * 0.9 ? cover : scale;
}

export interface ContentBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 원본 가장자리의 검은 띠(레터박스·필러박스)를 뺀 실제 화면 영역 (0~1). 줄마다 "가장 밝았던 때"의 밝기로 판단합니다. */
export function contentBox(rowPeak: ArrayLike<number>, colPeak: ArrayLike<number>, threshold = 0.07, maxShare = 0.35): ContentBox {
  const edges = (peak: ArrayLike<number>) => {
    const n = peak.length;
    const limit = Math.floor(n * maxShare);
    let start = 0;
    while (start < limit && peak[start] < threshold) start++;
    let end = n;
    while (n - end < limit && peak[end - 1] < threshold) end--;
    // 가운데도 어두우면(밤 장면만 있는 영상) 띠로 보지 않습니다.
    let brightest = 0;
    for (let i = start; i < end; i++) brightest = Math.max(brightest, peak[i]);
    if (brightest < threshold || end - start < n * 0.3) return [0, n];
    // 띠 경계가 분석 칸 중간에 걸리면 얇은 검은 선이 남으므로, 띠가 있던 쪽은 한 칸 더 안쪽까지 자릅니다.
    return [start ? start + 1 : 0, end < n ? end - 1 : n];
  };
  const [y0, y1] = edges(rowPeak);
  const [x0, x1] = edges(colPeak);
  return { x: x0 / colPeak.length, y: y0 / rowPeak.length, w: (x1 - x0) / colPeak.length, h: (y1 - y0) / rowPeak.length };
}
