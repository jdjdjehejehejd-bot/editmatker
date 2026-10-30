// 스토리 줄의 프리셋: 주제·특징과 편집 설정을 저장해 두고 한 번에 불러옵니다.
// 브라우저(localStorage)에만 저장되며, 저장소를 쓸 수 없으면 기본 프리셋만 보여 줍니다.

import type { Aspect } from "./render";
import type { LicenseMode } from "./sources";
import { FRAMING_LABEL, type Framing } from "./framing";
import { sanitizeOverlay, type OverlaySettings } from "./overlay";
import { sanitizeOverrides, type MusicStyle, type StyleOverrides } from "./style";

export interface Preset {
  id: string;
  name: string;
  topic: string;
  features: string;
  seconds: number;
  aspect: Aspect;
  sourceCount: number;
  licenseMode: LicenseMode;
  /** 배경음악 스타일 (예전 프리셋에는 없으므로 선택 사항) */
  musicStyle?: MusicStyle;
  /** 편집 스타일 직접 설정 */
  style?: StyleOverrides;
  /** 제목·출처·텍스트 */
  overlay?: OverlaySettings;
  /** 화면 맞추기 */
  framing?: Framing;
  /** 기본 제공 프리셋은 지울 수 없습니다 */
  builtin?: boolean;
}

export type PresetSettings = Omit<Preset, "id" | "name" | "builtin">;

const STORAGE_KEY = "editmatker.presets.v1";
export const MAX_PRESETS = 30;
const ASPECTS: Aspect[] = ["9:16", "16:9", "1:1"];
const SECONDS = [15, 30, 45, 60];
const MUSIC_STYLES: MusicStyle[] = ["auto", "hype", "cinematic", "emotional", "retro"];

const base = { seconds: 30, aspect: "9:16" as Aspect, sourceCount: 4, licenseMode: "any" as LicenseMode, builtin: true };
export const BUILTIN_PRESETS: Preset[] = [
  { ...base, id: "builtin-son", name: "손흥민", topic: "손흥민", features: "골 장면, 신나는 빠른 컷, 플래시" },
  { ...base, id: "builtin-newjeans", name: "뉴진스", topic: "뉴진스", features: "무대, 감성, 따뜻한 색감, 슬로우모션" },
  { ...base, id: "builtin-apollo", name: "아폴로 11호", topic: "아폴로 11호", features: "웅장하고 시네마틱하게, 로켓 발사, 슬로우모션" },
  { ...base, id: "builtin-tokyo", name: "Tokyo", topic: "Tokyo", features: "레트로 신스웨이브, 야경, 글리치, 네온" },
];

/** 저장된 값이 깨졌거나 예전 형식이어도 쓸 수 있는 값만 골라냅니다. */
export function sanitizePreset(value: any): Preset | null {
  if (!value || typeof value !== "object") return null;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 24) : "";
  const topic = typeof value.topic === "string" ? value.topic.slice(0, 200) : "";
  if (!name || !topic.trim()) return null;
  return {
    id: typeof value.id === "string" && value.id ? value.id : `preset-${Date.now()}`,
    name,
    topic,
    features: typeof value.features === "string" ? value.features.slice(0, 300) : "",
    seconds: SECONDS.includes(value.seconds) ? value.seconds : 30,
    aspect: ASPECTS.includes(value.aspect) ? value.aspect : "9:16",
    sourceCount: Number.isInteger(value.sourceCount) && value.sourceCount >= 2 && value.sourceCount <= 8 ? value.sourceCount : 4,
    licenseMode: value.licenseMode === "reusable" ? "reusable" : "any",
    musicStyle: MUSIC_STYLES.includes(value.musicStyle) ? value.musicStyle : "auto",
    style: sanitizeOverrides(value.style),
    overlay: sanitizeOverlay(value.overlay),
    framing: Object.prototype.hasOwnProperty.call(FRAMING_LABEL, value.framing) ? value.framing : "auto",
  };
}

export function loadPresets(storage: Pick<Storage, "getItem"> | null = safeStorage()): Preset[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map(sanitizePreset).filter((p): p is Preset => p !== null).slice(0, MAX_PRESETS) : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: Preset[], storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(presets.filter(p => !p.builtin).slice(0, MAX_PRESETS)));
  } catch {
    /* 저장 공간이 없거나 막힌 경우 — 이번 방문 동안만 유지됩니다 */
  }
}

/** 같은 이름이 있으면 덮어쓰고, 없으면 맨 앞에 추가합니다. */
export function upsertPreset(presets: Preset[], name: string, settings: PresetSettings, now = Date.now()): Preset[] {
  const clean = sanitizePreset({ ...settings, name, id: `preset-${now}` });
  if (!clean) return presets;
  const existing = presets.find(p => p.name === clean.name);
  if (existing) return presets.map(p => (p === existing ? { ...clean, id: existing.id } : p));
  return [clean, ...presets].slice(0, MAX_PRESETS);
}

/** 지금 입력이 이 프리셋과 같은지 (스토리 링 강조용) */
export function matchesPreset(preset: Preset, settings: PresetSettings) {
  return (
    preset.topic.trim() === settings.topic.trim() &&
    preset.features.trim() === settings.features.trim() &&
    preset.seconds === settings.seconds &&
    preset.aspect === settings.aspect &&
    preset.sourceCount === settings.sourceCount &&
    preset.licenseMode === settings.licenseMode &&
    (preset.musicStyle ?? "auto") === (settings.musicStyle ?? "auto") &&
    JSON.stringify(sanitizeOverrides(preset.style)) === JSON.stringify(sanitizeOverrides(settings.style)) &&
    JSON.stringify(sanitizeOverlay(preset.overlay)) === JSON.stringify(sanitizeOverlay(settings.overlay)) &&
    (preset.framing ?? "auto") === (settings.framing ?? "auto")
  );
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
