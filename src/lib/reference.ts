// 참고 에딧을 브라우저에서 분석합니다 (learn.ts의 순수 함수에 넘길 값을 만듭니다).

import { analyzeVideo } from "./analyze";
import { statsFromPixels, type ReferenceAnalysis } from "./learn";
import { screenFrames, type ModerationOptions } from "./moderation";
import { analyzeTempo } from "./music";

/** 참고 에딧은 짧은 영상만 씁니다(에딧은 보통 1분 안팎). */
export const MAX_REFERENCE_SECONDS = 180;

async function estimateBpm(blob: Blob): Promise<number | null> {
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / audio.numberOfChannels;
    }
    return analyzeTempo(mono, audio.sampleRate).bpm;
  } catch {
    return null; // 소리가 없거나 디코딩할 수 없는 영상
  }
}

/**
 * 참고 에딧 하나를 분석합니다. 부적절한 장면이 있으면 배우지 않습니다(검열 정책을 따름).
 * 컷을 정확히 세도록 0.1초 간격(최대 300장면)으로 훑습니다.
 */
export async function analyzeReference(
  blob: Blob,
  title: string,
  policy: ModerationOptions,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal
): Promise<ReferenceAnalysis> {
  const url = URL.createObjectURL(blob);
  try {
    const [analysis, bpm] = await Promise.all([analyzeVideo(blob, url, onProgress, signal, 300, 0.1), estimateBpm(blob)]);
    if (analysis.duration > MAX_REFERENCE_SECONDS) throw new Error("참고 에딧은 3분 이하 영상만 쓸 수 있어요.");
    const verdict = await screenFrames(analysis.keyframes, policy);
    if (verdict.blocked) throw new Error(verdict.reason ?? "부적절한 장면이 있어 참고하지 않았어요");
    const frames = analysis.keyframes.map(frame => {
      const ctx = frame.getContext("2d")!;
      return statsFromPixels(ctx.getImageData(0, 0, frame.width, frame.height).data, frame.width, frame.height);
    });
    return { title, duration: analysis.duration, samples: analysis.samples, frames, bpm };
  } finally {
    URL.revokeObjectURL(url);
  }
}
