// 새 버전이 배포됐는지 확인합니다. 이 앱은 필요할 때만 받는 파일(검열·장면 모델 등)이 있는데,
// 새로 배포되면 예전 이름의 파일이 사라져서, 배포 전에 열어 둔 페이지는 그 파일을 받지 못합니다.

/** 주소에서 "/assets/…" 부분만 (배포마다 바뀌는 파일 이름을 비교하려고) */
const assetPath = (src: string) => {
  const at = src.indexOf("/assets/");
  return at >= 0 ? src.slice(at).split(/[?#]/)[0] : null;
};

/** 이 페이지가 불러온 시작 스크립트 (배포마다 이름이 바뀜) */
function currentEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return script ? assetPath(script.src) : null;
}

/** 서버의 최신 index.html에 적힌 시작 스크립트 주소 */
export function entryFromHtml(html: string): string | null {
  const match = /<script[^>]+type="module"[^>]+src="([^"]+\/assets\/[^"]+\.js)"/.exec(html) ?? /<script[^>]+src="([^"]+\/assets\/[^"]+\.js)"[^>]*type="module"/.exec(html);
  return match ? assetPath(match[1]) : null;
}

/** 새 버전이 배포됐으면 true. 확인할 수 없으면(오프라인, 개발 서버) false */
export async function isOutdated(): Promise<boolean> {
  const mine = currentEntry();
  if (!mine) return false;
  try {
    const response = await fetch(`${location.pathname}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return false;
    const latest = entryFromHtml(await response.text());
    return Boolean(latest && latest !== mine);
  } catch {
    return false;
  }
}

/** 필요할 때 받는 파일을 못 받은 오류인지 (배포 전에 열어 둔 페이지에서 흔함) */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch dynamically|ChunkLoadError|Unable to preload/i.test(message);
}

export const OUTDATED_MESSAGE = "새 버전이 배포돼서 이 페이지가 필요한 파일을 받지 못했어요. 새로고침한 뒤 다시 만들어 주세요(입력한 내용은 그대로 남아요).";

const DRAFT_KEY = "editmatker.draft.v1";

/** 새로고침 전에 입력을 잠깐 저장해 두고, 다시 열 때 되살립니다(파일은 저장할 수 없음). */
export function saveDraft(draft: Record<string, unknown>) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* 저장 불가 */
  }
}

export function takeDraft(): Record<string, unknown> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
