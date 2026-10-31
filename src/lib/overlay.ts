// 영상 위에 얹는 글자: 시작 제목, 끝 출처(크레딧), 사용자가 넣은 텍스트. 브라우저 API에 의존하지 않는 순수 함수입니다.

export type TextPosition = "top" | "center" | "bottom";
export type TextSize = "small" | "medium" | "large";

export interface TextOverlay {
  text: string;
  /** 시작 시각(초, 영상 처음부터) */
  start: number;
  /** 보이는 시간(초) */
  duration: number;
  position: TextPosition;
  size: TextSize;
}

export interface OverlaySettings {
  /** 시작 부분에 제목을 넣을지 */
  showTitle: boolean;
  /** 직접 입력한 제목 (비우면 주제 이름) */
  title: string;
  /** 제목 아래 작은 글씨 (비우면 없음). 예전에는 편집 방식이 자동으로 들어갔습니다. */
  subtitle: string;
  /** 끝에 출처(크레딧) 화면을 넣을지 */
  showCredits: boolean;
  texts: TextOverlay[];
}

export const DEFAULT_OVERLAY: OverlaySettings = { showTitle: true, title: "", subtitle: "", showCredits: true, texts: [] };
export const MAX_TEXTS = 8;
export const MAX_TEXT_LENGTH = 80;
export const TEXT_POSITION_LABEL: Record<TextPosition, string> = { top: "위", center: "가운데", bottom: "아래" };
export const TEXT_SIZE_LABEL: Record<TextSize, string> = { small: "작게", medium: "보통", large: "크게" };
/** 화면 짧은 변 대비 글자 크기 */
export const TEXT_SIZE_RATIO: Record<TextSize, number> = { small: 0.045, medium: 0.065, large: 0.09 };
const TEXT_FADE = 0.25;

const has = (table: object, key: unknown) => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
const number = (value: unknown, fallback: number, min: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback);

export function newText(start = 0): TextOverlay {
  return { text: "", start, duration: 2, position: "bottom", size: "medium" };
}

export function sanitizeText(value: any): TextOverlay | null {
  if (!value || typeof value !== "object" || typeof value.text !== "string") return null;
  return {
    text: value.text.slice(0, MAX_TEXT_LENGTH),
    start: number(value.start, 0, 0, 600),
    duration: number(value.duration, 2, 0.3, 60),
    position: has(TEXT_POSITION_LABEL, value.position) ? value.position : "bottom",
    size: has(TEXT_SIZE_LABEL, value.size) ? value.size : "medium",
  };
}

export function sanitizeOverlay(value: any): OverlaySettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_OVERLAY, texts: [] };
  return {
    showTitle: value.showTitle !== false,
    title: typeof value.title === "string" ? value.title.slice(0, MAX_TEXT_LENGTH) : "",
    subtitle: typeof value.subtitle === "string" ? value.subtitle.slice(0, MAX_TEXT_LENGTH) : "",
    showCredits: value.showCredits !== false,
    texts: (Array.isArray(value.texts) ? value.texts : []).map(sanitizeText).filter((t: TextOverlay | null): t is TextOverlay => t !== null).slice(0, MAX_TEXTS),
  };
}

/** 렌더링에 쓸 텍스트만 (빈 글자 빼고, 편집 길이 안으로 자름) */
export function renderableTexts(texts: TextOverlay[], duration: number): TextOverlay[] {
  return texts
    .map(t => ({ ...t, text: t.text.trim() }))
    .filter(t => t.text && t.start < duration)
    .map(t => ({ ...t, duration: Math.min(t.duration, duration - t.start) }));
}

/** 시각 now에 텍스트가 얼마나 보이는지 (0~1, 앞뒤로 살짝 페이드) */
export function textAlpha(text: TextOverlay, now: number): number {
  const local = now - text.start;
  if (local < 0 || local > text.duration) return 0;
  const fade = Math.min(TEXT_FADE, text.duration / 3);
  return Math.min(1, local / fade, (text.duration - local) / fade);
}

/** 텍스트 줄의 세로 위치(화면 높이 대비, 가운데 기준) */
export function textAnchorY(position: TextPosition): number {
  return position === "top" ? 0.16 : position === "center" ? 0.5 : 0.82;
}
