// 무료 배경음악: Openverse(Jamendo·Freesound·ccMixter 등 CC 라이선스 음원을 모아 둔 공개 검색)에서
// 분위기에 맞는 곡을 찾아 받습니다. 키가 필요 없고, 2차 편집이 허용된 라이선스만 씁니다.
// SoundCloud는 새 API 등록을 받지 않고 이용 약관상 곡을 내려받아 편집에 쓸 수 없어 연동하지 않습니다.

import { proxyBase } from "./social";
import type { Mood } from "./style";

export interface FreeTrack {
  id: string;
  title: string;
  creator: string;
  /** 음원 파일 주소 */
  url: string;
  /** 출처 페이지 */
  pageUrl: string;
  license: string;
  licenseUrl: string | null;
  /** 초 (모르면 null) */
  duration: number | null;
  provider: string;
}

const OPENVERSE = "https://api.openverse.org/v1/audio/";
/** 분위기별 검색어 — 음악 장르·느낌을 영어로. 매번 같은 곡만 나오지 않게 여러 개 중에서 고릅니다(첫 번째가 대표). */
export const MUSIC_QUERIES: Record<Mood, string[]> = {
  hype: ["energetic electronic beat", "hip hop beat", "trap beat", "edm upbeat", "electronic dance", "phonk", "dubstep"],
  cinematic: ["epic cinematic orchestral", "cinematic trailer", "epic orchestra", "dramatic score", "heroic soundtrack", "cinematic ambient"],
  emotional: ["emotional piano ambient", "sad piano", "calm acoustic", "lofi chill", "ambient soft", "emotional strings"],
  retro: ["synthwave retro 80s", "retrowave", "chiptune", "80s synth pop", "vaporwave", "outrun"],
};

const RECENT_KEY = "editmatker.recentTracks.v1";
/** 최근에 쓴 곡을 이만큼 기억해서 다음에는 피합니다 */
const RECENT_LIMIT = 30;

export function loadRecentTracks(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string[] {
  try {
    const list = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function rememberTrack(id: string, storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage) {
  try {
    const list = [id, ...loadRecentTracks(storage).filter(other => other !== id)].slice(0, RECENT_LIMIT);
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 저장 불가 */
  }
}

/** 최근에 쓴 곡은 뒤로 미루고, 나머지는 섞습니다(같은 곡이 계속 나오지 않게). 새 곡이 없으면 오래전에 쓴 곡부터. */
export function orderTracks(tracks: FreeTrack[], recent: string[], random: () => number = Math.random): FreeTrack[] {
  const fresh = tracks.filter(t => !recent.includes(t.id));
  const used = tracks.filter(t => recent.includes(t.id)).sort((a, b) => recent.indexOf(b.id) - recent.indexOf(a.id));
  const shuffled = fresh.map(t => ({ t, k: random() })).sort((a, b) => a.k - b.k).map(e => e.t);
  return [...shuffled, ...used];
}
/** 너무 긴 곡(라이브 녹음, 1시간짜리 믹스)은 받는 데 오래 걸리고 메모리를 많이 써서 뺍니다 */
const MAX_TRACK_SECONDS = 8 * 60;
const MAX_TRACK_BYTES = 40 * 1024 * 1024;

/** Openverse 라이선스 코드("by-sa", "cc0", "pdm") → 표기 ("CC BY-SA 4.0") */
export function licenseName(license: unknown, version: unknown): string {
  const code = typeof license === "string" ? license.toLowerCase() : "";
  if (code === "pdm") return "Public domain";
  if (code === "cc0") return "CC0";
  if (!code) return "CC";
  const label = `CC ${code.toUpperCase()}`;
  return typeof version === "string" && version ? `${label} ${version}` : label;
}

/** Openverse 오디오 검색 응답 → 곡 목록 (편집 길이보다 짧은 곡, 너무 긴 곡, 파일 주소가 없는 곡은 뺌) */
export function parseOpenverse(data: any, minSeconds: number): FreeTrack[] {
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results.flatMap(item => {
    if (typeof item?.url !== "string" || !/^https?:\/\//.test(item.url)) return [];
    // 비상업(NC)은 괜찮지만 변경 금지(ND)는 편집(자르기·섞기)이 안 되므로 뺍니다.
    if (typeof item.license === "string" && /nd/i.test(item.license)) return [];
    const duration = Number.isFinite(item.duration) ? Number(item.duration) / 1000 : null;
    if (duration !== null && (duration < minSeconds || duration > MAX_TRACK_SECONDS)) return [];
    if (Number.isFinite(item.filesize) && item.filesize > MAX_TRACK_BYTES) return [];
    return [
      {
        id: `openverse:${item.id}`,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Untitled",
        creator: typeof item.creator === "string" && item.creator.trim() ? item.creator.trim() : "Unknown",
        url: item.url.replace(/^http:\/\//, "https://"),
        pageUrl: typeof item.foreign_landing_url === "string" ? item.foreign_landing_url : "",
        license: licenseName(item.license, item.license_version),
        licenseUrl: typeof item.license_url === "string" ? item.license_url : null,
        duration,
        provider: typeof item.source === "string" ? item.source : typeof item.provider === "string" ? item.provider : "Openverse",
      },
    ];
  });
}

/** 분위기에 맞는 무료 곡을 찾습니다. 편집 길이(+출처 화면)보다 긴 곡만 고릅니다. */
export async function findFreeMusic(mood: Mood, seconds: number, signal?: AbortSignal): Promise<FreeTrack[]> {
  // 같은 검색어·같은 첫 페이지만 보면 늘 같은 곡이 나오므로, 검색어 두 개와 페이지(1~3)를 무작위로 고르고
  // 최근에 쓴 곡은 뒤로 미룹니다.
  const queries = MUSIC_QUERIES[mood];
  const first = Math.floor(Math.random() * queries.length);
  const picks = [queries[first], queries[(first + 1 + Math.floor(Math.random() * (queries.length - 1))) % queries.length]];
  const search = async (q: string, page: number) => {
    const params = new URLSearchParams({ q, category: "music", license_type: "modification", page_size: "20", page: String(page), mature: "false" });
    const response = await fetch(`${OPENVERSE}?${params}`, { signal });
    if (!response.ok) throw new Error(`무료 음악 검색 오류 (${response.status})`);
    return parseOpenverse(await response.json(), seconds);
  };
  const results = await Promise.allSettled(picks.map(q => search(q, 1 + Math.floor(Math.random() * 3))));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  let tracks = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  // 뒤쪽 페이지에 곡이 없으면(결과가 적은 검색어) 대표 검색어 첫 페이지로 한 번 더 찾습니다.
  if (!tracks.length) tracks = await search(queries[0], 1);
  const unique = [...new Map(tracks.map(t => [t.id, t])).values()];
  return orderTracks(unique, loadRecentTracks());
}

/** 곡 파일을 받습니다. 음원 서버가 브라우저에서 직접 받는 걸 막으면(CORS) 같은 사이트의 프록시로 다시 받습니다. */
export async function downloadTrack(track: FreeTrack, signal?: AbortSignal): Promise<File> {
  const read = async (url: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`음악을 받지 못했어요 (${response.status})`);
    const blob = await response.blob();
    if (blob.size > MAX_TRACK_BYTES) throw new Error("음악 파일이 너무 커요");
    return new File([blob], `${track.title}.mp3`, { type: blob.type || "audio/mpeg" });
  };
  try {
    return await read(track.url);
  } catch (error) {
    if (signal?.aborted) throw error;
    return read(`${proxyBase()}/api/media?url=${encodeURIComponent(track.url)}`);
  }
}

/** 출처 표기 한 줄 (CC BY는 작성자·라이선스를 밝혀야 함) */
export function trackCredit(track: FreeTrack): string {
  return `Music: "${track.title}" — ${track.creator} · ${track.license} · ${track.provider}`;
}
