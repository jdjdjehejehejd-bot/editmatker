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

export interface FocusPoint {
  t: number;
  x: number;
  y: number;
}

/** 관심 지점을 시간에 따라 부드럽게 만듭니다(±window초 평균) — 카메라가 덜덜 떨지 않게. */
export function smoothTrack(points: FocusPoint[], window = 0.8): FocusPoint[] {
  return points.map(point => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const other of points) {
      if (Math.abs(other.t - point.t) <= window) {
        sx += other.x;
        sy += other.y;
        n++;
      }
    }
    return { t: point.t, x: sx / n, y: sy / n };
  });
}

/** 시각 t의 관심 지점 (앞뒤 점 사이를 이어서) */
export function focusAt(track: FocusPoint[], t: number): { x: number; y: number } {
  if (!track.length) return { x: 0.5, y: 0.5 };
  if (t <= track[0].t) return track[0];
  for (let i = 1; i < track.length; i++) {
    if (t <= track[i].t) {
      const a = track[i - 1];
      const b = track[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return track[track.length - 1];
}

/**
 * 화면(view)보다 크게 그린 영상(drawn)에서, 관심 지점이 화면 가운데에 오도록 하는 위치.
 * 영상 가장자리 밖이 보이지 않게 [view - drawn, 0] 범위로 묶습니다.
 */
export function cropOffset(focus: number, drawn: number, view: number): number {
  const ideal = view / 2 - focus * drawn;
  return Math.min(0, Math.max(view - drawn, ideal));
}
