// 주제 → 영상 검색 → 다운로드 → 하이라이트 분석 → 편집 계획까지의 전체 흐름입니다.

import { analyzeVideo, type VideoAnalysis } from "./analyze";
import { LIMITS } from "./device";
import { checkUserInput, GenerationBlockedError, isTextAllowed, isTopicAllowed, preloadClassifier, screenFrames, shouldBlockTopic } from "./moderation";
import { pickHighlights, scoreSamples, type Highlight } from "./highlights";
import { prepareUserMusic, synthesizeMusic } from "./music";
import { buildPlan, requiredHighlightLength, type EditPlan } from "./plan";
import { CREDIT_SECONDS } from "./render";
import { allocateSlots, combinedTitle, expandQueries, matchesTopic, parseTopicInput } from "./topic";
import { describeError, downloadSource, findSources, summarizeReports, resolveTopic, type LicenseMode, type SearchReport, type SourceVideo, type TopicInfo } from "./sources";
import { parseStyle, type EditStyle } from "./style";

export type StepId = "topic" | "search" | "download" | "analyze" | "plan" | "render";

export interface LoadedSource extends SourceVideo {
  url: string;
  analysis: VideoAnalysis;
  scores: number[];
  highlights: Highlight[];
  /** 이 영상을 찾은 주제 */
  topicLabel: string;
}

export interface PipelineInput {
  /** 쉼표로 여러 주제, "N:단어:"로 N배 비중 */
  topic: string;
  features: string;
  seconds: number;
  licenseMode: LicenseMode;
  /** 로컬 도우미 주소 (YouTube 영상에 필요) */
  helper: string | null;
  sourceCount: number;
  musicFile: File | null;
}

export interface TopicResult {
  info: TopicInfo;
  weight: number;
  queries: string[];
  candidates: SourceVideo[];
  reports: SearchReport[];
}

export interface PipelineResult {
  topics: TopicResult[];
  title: string;
  style: EditStyle;
  sources: LoadedSource[];
  plan: EditPlan;
  music: { buffer: AudioBuffer; offset: number };
  credits: string[];
}

export interface QueryGroup {
  label: string;
  weight: number;
  queries: string[];
}

export interface PipelineEvents {
  step: (id: StepId, detail: string, ratio?: number) => void;
  candidates: (sources: SourceVideo[]) => void;
  queries: (groups: QueryGroup[]) => void;
  loaded: (source: LoadedSource) => void;
  skipped: (source: SourceVideo, reason: string) => void;
}

/** 여러 주제를 동시에 쓸 때 한 번에 받을 영상 수의 상한 */
const MAX_TOTAL_SOURCES = 8;

export async function runPipeline(input: PipelineInput, events: PipelineEvents, signal: AbortSignal): Promise<PipelineResult> {
  // 검열: 부적절한 단어가 있으면 시작하지 않습니다.
  const blocked = checkUserInput(input.topic, input.features);
  if (blocked) throw new GenerationBlockedError(blocked);
  const style = parseStyle(input.features);
  const specs = parseTopicInput(input.topic);
  if (!specs.length) throw new Error("주제를 입력해 주세요.");

  events.step("topic", specs.length > 1 ? `주제 ${specs.length}개를 해석하는 중` : `"${specs[0].term}" 주제를 해석하는 중`);
  const infos = await Promise.all(specs.map(spec => resolveTopic(spec.term, signal)));
  // 검열: 주제가 가리키는 대상(영어 이름, 설명)이 부적절하면 생성하지 않습니다.
  const badTopic = infos.find(info => !isTopicAllowed(info));
  if (badTopic) throw new GenerationBlockedError(`생성 불가 — 주제 "${badTopic.query}"는 검열 대상이에요.`);

  const where = input.licenseMode === "any" ? (input.helper ? "YouTube·Reddit" : "Reddit") : "Wikimedia Commons·Internet Archive";
  const queriesFor = (info: TopicInfo) =>
    input.licenseMode === "any" ? expandQueries(info, style.searchHints).map(q => q.q) : [info.englishLabel ?? info.label, ...(info.related ?? []).slice(0, 3)];
  const groups = infos.map((info, i) => ({ label: info.label, weight: specs[i].weight, queries: queriesFor(info) }));
  events.queries(groups);
  const queryCount = groups.reduce((sum, g) => sum + g.queries.length, 0);
  events.step("search", `${where}에서 ${queryCount}가지 검색어로 찾는 중`);
  const found = await Promise.all(infos.map(info => findSources(info, style.searchHints, input.licenseMode, input.helper, signal)));

  // 여러 주제에 같은 영상이 걸리면 먼저 나온 주제에만 둡니다.
  const claimed = new Set<string>();
  const censored: string[] = [];
  let irrelevant = 0;
  const topics: TopicResult[] = infos.map((info, i) => {
    // 검열: 제목·채널·분류에 금지어가 있거나 출처가 성인물로 표시한 영상은 받지 않습니다.
    const flagged = found[i].sources.filter(source => source.nsfw || !isTextAllowed(source.title, source.author, source.tags));
    // 찾은 영상 중 상당수가 검열 대상이면 주제 자체를 막습니다.
    if (shouldBlockTopic(flagged.length, found[i].sources.length)) {
      const percent = Math.round((flagged.length / found[i].sources.length) * 100);
      throw new GenerationBlockedError(`생성 불가 — "${info.query}"로 찾은 영상의 ${percent}%(${flagged.length}/${found[i].sources.length}개)가 검열 대상이에요.`);
    }
    const flaggedIds = new Set(flagged.map(source => source.id));
    const candidates = found[i].sources.filter(source => {
      if (claimed.has(source.id)) return false;
      if (flaggedIds.has(source.id)) {
        claimed.add(source.id);
        censored.push(source.id);
        if (!source.nsfw) events.skipped(source, "부적절한 단어가 있어 제외했어요");
        return false;
      }
      // 관련성: 제목·태그·채널에 주제 이름이 나오는 영상(또는 주제의 Commons 분류·대표 영상)만 씁니다.
      if (!source.trusted && !matchesTopic([source.title, source.tags, source.author].filter(Boolean).join(" "), info)) {
        irrelevant++;
        return false;
      }
      return true;
    });
    candidates.forEach(source => claimed.add(source.id));
    return { info, weight: specs[i].weight, queries: groups[i].queries, candidates, reports: found[i].reports };
  });
  events.candidates(topics.flatMap(t => t.candidates));
  const active = topics.filter(t => t.candidates.length);
  if (!active.length) {
    const scope = input.licenseMode === "reusable" ? "재사용 가능한 라이선스의 " : "";
    const details = topics.map(t => (topics.length > 1 ? `[${t.info.label}]\n` : "") + summarizeReports(t.reports)).join("\n\n");
    const censorNote = censored.length ? `\n\n검열: 부적절한 단어가 있는 영상 ${censored.length}개 제외` : "";
    const relevanceNote = irrelevant ? `\n관련성: 제목에 주제 이름이 없는 영상 ${irrelevant}개 제외` : "";
    const names = topics.map(t => `"${t.info.label}"`).join(", ");
    throw new Error(`${scope}${names}이(가) 나오는 영상을 찾지 못했어요. 이름을 정확히(또는 영어로) 입력해 보세요.\n\n${details}${censorNote}${relevanceNote}`);
  }
  const failures: string[] = topics.filter(t => !t.candidates.length).map(t => `주제 "${t.info.label}": 영상을 찾지 못했어요`);
  if (censored.length) failures.push(`검열: 부적절한 단어가 있는 영상 ${censored.length}개 제외`);
  if (irrelevant) failures.push(`관련성: 제목에 주제 이름이 없는 영상 ${irrelevant}개 제외`);
  // 영상을 받는 동안 장면 검열 모델도 미리 받아 둡니다.
  preloadClassifier();

  // 음악 템포가 정해져야 하이라이트 길이를 정할 수 있습니다.
  const userMusic = input.musicFile ? await prepareUserMusic(input.musicFile, input.seconds) : null;
  const bpm = userMusic?.bpm ?? style.bpm;
  const highlightLength = requiredHighlightLength(style, bpm);
  const approxCuts = Math.ceil(input.seconds / ((60 / bpm) * 2));

  // 영상 칸을 주제 비중대로 나눕니다. 주제가 많으면 주제마다 최소 1개는 받습니다.
  const slots = Math.min(MAX_TOTAL_SOURCES, Math.max(input.sourceCount, active.length));
  const quota = allocateSlots(active.map(t => t.weight), slots);
  const totalWeight = active.reduce((sum, t) => sum + t.weight, 0);

  const loaded: LoadedSource[] = [];
  const loadedBy = new Map<TopicResult, LoadedSource[]>(active.map(t => [t, []]));
  // 장면 검열 결과(검사한 수, 걸린 수)를 주제별로 셉니다.
  const screening = new Map<TopicResult, { checked: number; blocked: number }>(active.map(t => [t, { checked: 0, blocked: 0 }]));
  const cursor = new Map<TopicResult, number>(active.map(t => [t, 0]));

  const tryNext = async (topic: TopicResult, perSource: number): Promise<boolean> => {
    let index = cursor.get(topic)!;
    while (index < topic.candidates.length) {
      const candidate = topic.candidates[index++];
      cursor.set(topic, index);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const label = `${loaded.length + 1}/${slots} · ${candidate.title}`;
      try {
        events.step("download", label, 0);
        const blob = await downloadSource(candidate, ratio => events.step("download", label, ratio), signal, LIMITS.sourceBytes);
        const url = URL.createObjectURL(blob);
        try {
          events.step("analyze", `${candidate.title} 장면 분석 중`, 0);
          const analysis = await analyzeVideo(blob, url, ratio => events.step("analyze", `${candidate.title} 장면 분석 중`, ratio), signal, LIMITS.analysisSamples);
          // 검열: 실제 장면을 검사해 선정적인 영상은 쓰지 않습니다.
          events.step("analyze", `${candidate.title} 장면 검열 중`);
          const verdict = await screenFrames(analysis.keyframes);
          analysis.keyframes = [];
          const tally = screening.get(topic)!;
          tally.checked++;
          if (verdict.blocked) {
            tally.blocked++;
            // 받아 본 영상 중 상당수에서 부적절한 장면이 나오면 주제 자체를 막습니다.
            if (shouldBlockTopic(tally.blocked, tally.checked)) {
              throw new GenerationBlockedError(`생성 불가 — "${topic.info.query}" 영상 ${tally.checked}개 중 ${tally.blocked}개에서 부적절한 장면이 감지됐어요.`);
            }
            throw new Error(verdict.reason ?? "부적절한 장면이 감지되어 제외했어요");
          }
          const scores = scoreSamples(analysis.samples, style.weights);
          const length = Math.min(highlightLength, analysis.duration * 0.5);
          const highlights = pickHighlights(candidate.id, analysis.samples, scores, length, perSource, analysis.duration);
          if (!highlights.length) throw new Error("쓸 만한 장면이 없었어요.");
          const source: LoadedSource = { ...candidate, duration: analysis.duration, url, analysis, scores, highlights, topicLabel: topic.info.label };
          loaded.push(source);
          loadedBy.get(topic)!.push(source);
          events.loaded(source);
          return true;
        } catch (error) {
          URL.revokeObjectURL(url);
          throw error;
        }
      } catch (error) {
        if (signal.aborted || error instanceof GenerationBlockedError) throw error;
        const reason = describeError(error);
        failures.push(`${candidate.provider} "${candidate.title.slice(0, 40)}": ${reason}`);
        events.skipped(candidate, reason);
      }
    }
    return false;
  };

  // 1) 주제별 몫을 채웁니다 (비중이 큰 주제부터).
  const byWeight = active.map((t, i) => ({ t, q: quota[i] })).sort((a, b) => b.t.weight - a.t.weight);
  for (const { t, q } of byWeight) {
    const perSource = Math.ceil((approxCuts * (t.weight / totalWeight)) / Math.max(1, q)) + 2;
    while (loadedBy.get(t)!.length < q && (await tryNext(t, perSource))) {
      /* 몫을 채울 때까지 */
    }
  }
  // 2) 영상이 모자란 주제가 있으면 남은 칸을 다른 주제의 다음 후보로 채웁니다.
  for (let progress = true; loaded.length < slots && progress; ) {
    progress = false;
    for (const { t } of byWeight) {
      if (loaded.length >= slots) break;
      if (await tryNext(t, Math.ceil(approxCuts / slots) + 2)) progress = true;
    }
  }

  if (!loaded.length) {
    const more = failures.length > 6 ? `\n…외 ${failures.length - 6}개` : "";
    throw new Error(`찾은 영상을 불러오지 못했어요. 잠시 후 다시 시도하거나 다른 주제를 입력해 보세요.\n\n${failures.slice(0, 6).join("\n")}${more}`);
  }

  // 편집에서 각 주제가 비중만큼 나오도록, 주제 비중을 그 주제의 영상 수로 나눠 영상마다 나눠 줍니다.
  const usedWeight = active.filter(t => loadedBy.get(t)!.length).reduce((sum, t) => sum + t.weight, 0);
  for (const t of active) {
    const sources = loadedBy.get(t)!;
    for (const source of sources) for (const h of source.highlights) h.weight = t.weight / usedWeight / sources.length;
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

  const title = combinedTitle(active.filter(t => loadedBy.get(t)!.length).map(t => t.info.label));
  return { topics, title, style, sources: loaded, plan, music, credits };
}
