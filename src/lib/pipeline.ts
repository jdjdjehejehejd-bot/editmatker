// 주제 → 영상 검색 → 다운로드 → 하이라이트 분석 → 편집 계획까지의 전체 흐름입니다.

import { analyzeVideo, type VideoAnalysis } from "./analyze";
import { LIMITS } from "./device";
import { pickHighlights, scoreSamples, type Highlight } from "./highlights";
import { prepareUserMusic, synthesizeMusic } from "./music";
import { buildPlan, requiredHighlightLength, type EditPlan } from "./plan";
import { CREDIT_SECONDS } from "./render";
import { socialQueries } from "./social";
import { describeError, downloadSource, findSources, summarizeReports, resolveTopic, type LicenseMode, type SourceVideo, type TopicInfo } from "./sources";
import { parseStyle, type EditStyle } from "./style";

export type StepId = "topic" | "search" | "download" | "analyze" | "plan" | "render";

export interface LoadedSource extends SourceVideo {
  url: string;
  analysis: VideoAnalysis;
  scores: number[];
  highlights: Highlight[];
}

export interface PipelineInput {
  topic: string;
  features: string;
  seconds: number;
  licenseMode: LicenseMode;
  /** 로컬 도우미 주소 (YouTube 영상에 필요) */
  helper: string | null;
  sourceCount: number;
  musicFile: File | null;
}

export interface PipelineResult {
  topic: TopicInfo;
  style: EditStyle;
  sources: LoadedSource[];
  plan: EditPlan;
  music: { buffer: AudioBuffer; offset: number };
  credits: string[];
}

export interface PipelineEvents {
  step: (id: StepId, detail: string, ratio?: number) => void;
  candidates: (sources: SourceVideo[]) => void;
  loaded: (source: LoadedSource) => void;
  skipped: (source: SourceVideo, reason: string) => void;
}

export async function runPipeline(input: PipelineInput, events: PipelineEvents, signal: AbortSignal): Promise<PipelineResult> {
  const style = parseStyle(input.features);

  events.step("topic", `"${input.topic}" 주제를 해석하는 중`);
  const topic = await resolveTopic(input.topic, signal);

  const where = input.licenseMode === "any" ? (input.helper ? "YouTube·Reddit" : "Reddit") : "Wikimedia Commons·Internet Archive";
  const queries = input.licenseMode === "any" ? socialQueries(topic, style.searchHints) : [topic.englishLabel ?? topic.label];
  events.step("search", `${where}에서 찾는 중 · ${queries.map(q => `"${q}"`).join(", ")}`);
  const { sources: candidates, reports } = await findSources(topic, style.searchHints, input.licenseMode, input.helper, signal);
  events.candidates(candidates);
  if (!candidates.length) {
    const scope = input.licenseMode === "reusable" ? "재사용 가능한 라이선스의 " : "";
    throw new Error(`${scope}관련 영상을 찾지 못했어요. 주제를 영어 이름이나 더 넓은 키워드로 바꿔 보세요.\n\n${summarizeReports(reports)}`);
  }

  // 음악 템포가 정해져야 하이라이트 길이를 정할 수 있습니다.
  const userMusic = input.musicFile ? await prepareUserMusic(input.musicFile, input.seconds) : null;
  const bpm = userMusic?.bpm ?? style.bpm;
  const highlightLength = requiredHighlightLength(style, bpm);
  const approxCuts = Math.ceil(input.seconds / ((60 / bpm) * 2));

  const loaded: LoadedSource[] = [];
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (loaded.length >= input.sourceCount) break;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      events.step("download", `${loaded.length + 1}/${input.sourceCount} · ${candidate.title}`, 0);
      const blob = await downloadSource(candidate, ratio => events.step("download", `${loaded.length + 1}/${input.sourceCount} · ${candidate.title}`, ratio), signal, LIMITS.sourceBytes);
      const url = URL.createObjectURL(blob);
      try {
        events.step("analyze", `${candidate.title} 장면 분석 중`, 0);
        const analysis = await analyzeVideo(blob, url, ratio => events.step("analyze", `${candidate.title} 장면 분석 중`, ratio), signal, LIMITS.analysisSamples);
        const scores = scoreSamples(analysis.samples, style.weights);
        const length = Math.min(highlightLength, analysis.duration * 0.5);
        const perSource = Math.ceil(approxCuts / input.sourceCount) + 2;
        const highlights = pickHighlights(candidate.id, analysis.samples, scores, length, perSource, analysis.duration);
        if (!highlights.length) throw new Error("쓸 만한 장면이 없었어요.");
        const source: LoadedSource = { ...candidate, duration: analysis.duration, url, analysis, scores, highlights };
        loaded.push(source);
        events.loaded(source);
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = describeError(error);
      failures.push(`${candidate.provider} "${candidate.title.slice(0, 40)}": ${reason}`);
      events.skipped(candidate, reason);
    }
  }
  if (!loaded.length) {
    const more = failures.length > 6 ? `\n…외 ${failures.length - 6}개` : "";
    throw new Error(`찾은 영상을 불러오지 못했어요. 잠시 후 다시 시도하거나 다른 주제를 입력해 보세요.\n\n${failures.slice(0, 6).join("\n")}${more}`);
  }

  events.step("plan", "비트에 맞춰 컷을 배치하는 중");
  const plan = buildPlan({
    highlights: loaded.flatMap(s => s.highlights),
    style,
    totalSeconds: input.seconds,
    bpm,
    beatOffset: userMusic?.beatOffset,
    dropAt: userMusic?.dropAt,
  });
  const outroAt = plan.segments.find(s => s.section === "outro")?.start ?? plan.duration;
  const music = userMusic
    ? { buffer: userMusic.buffer, offset: userMusic.offset }
    : {
        buffer: await synthesizeMusic({ mood: style.mood, bpm, duration: plan.duration + CREDIT_SECONDS, dropAt: plan.dropAt, outroAt }),
        offset: 0,
      };

  const used = new Set(plan.segments.map(s => s.sourceId));
  const credits = loaded
    .filter(s => used.has(s.id))
    .map(s => `"${s.title}" — ${s.author} · ${s.license} · ${s.provider}`);
  if (!userMusic) credits.push("Music: generated by editmatker");

  return { topic, style, sources: loaded, plan, music, credits };
}
