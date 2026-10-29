// 휴대폰에서 메모리·발열을 줄이고, 모바일 브라우저의 제약(오디오 잠금, 화면 꺼짐)을 다룹니다.

export const isMobile =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

export const LIMITS = isMobile
  ? { sourceBytes: 60 * 1024 * 1024, analysisSamples: 140, defaultSources: 3, maxSources: 4 }
  : { sourceBytes: 150 * 1024 * 1024, analysisSamples: 240, defaultSources: 4, maxSources: 6 };

/**
 * iOS Safari는 사용자가 버튼을 누른 그 순간에 만든 AudioContext만 소리를 냅니다.
 * 버튼을 누를 때 미리 만들어 무음으로 깨워 두고, 렌더링 단계에서 넘겨받아 씁니다.
 */
export function unlockAudio(): AudioContext {
  const audio = new AudioContext();
  const silence = audio.createBufferSource();
  silence.buffer = audio.createBuffer(1, 1, audio.sampleRate);
  silence.connect(audio.destination);
  silence.start();
  void audio.resume().catch(() => undefined);
  return audio;
}

/** 작업하는 동안 화면이 꺼지지 않게 합니다(지원하는 브라우저만). */
export async function keepScreenOn(): Promise<() => void> {
  try {
    const lock = await (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen");
    return () => void lock?.release().catch(() => undefined);
  } catch {
    return () => undefined;
  }
}

/** 휴대폰 공유 시트(사진 앱 저장, 인스타그램 등)로 보낼 수 있는지 */
export function canShareFile(file: File) {
  return typeof navigator !== "undefined" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}
