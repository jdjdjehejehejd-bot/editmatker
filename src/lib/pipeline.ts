// 주제 → 영상 검색 → 다운로드 → 하이라이트 분석 → 편집 계획까지의 전체 흐름입니다.

import { analyzeVideo, type VideoAnalysis } from "./analyze";
import { isMobile, LIMITS } from "./device";
import { checkUserInput, GenerationBlockedError, type ModerationOptions, isNsfwRequested, isTextAllowedWith, isTopicAllowed, preloadClassifier, screenFrames, shouldBlockTopic } from "./moderation";
import { pickHighlights, scoreSamples, type Highlight } from "./highlights";
import { prepareUserMusic, synthesizeMusic } from "./music";
import { buildPlan, requiredHighlightLength, type EditPlan } from "./plan";
import { tailSeconds } from "./render";
import { allocateSlots, combinedTitle, createTopicMatcher, expandQueries, mentionsSports, parseTopicInput } from "./topic";
import type { StockKeys } from "./stock";
import { describeError, downloadSource, findSources, REASON, summarizeReports, resolveTopic, uploadedSource, type LicenseMode, type SearchReport, type SourceVideo, type TopicInfo } from "./sources";
import { applyProfile, buildProfile, describeProfile, type ReferenceAnalysis, type StyleProfile } from "./learn";
import { analyzeReference } from "./reference";
import { searchReferenceEdits } from "./social";
import { applyOverrides, defaultBpm, parseStyle, type EditStyle, type Mood, type MusicStyle, type StyleOverrides } from "./style";

export type StepId = "topic" | "search" | "learn" | "download" | "analyze" | "plan" | "render";

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
  /** Pexels·Pixabay API 키 (비어 있으면 서버 환경 변수 키를 씀) */
  stockKeys?: StockKeys;
  sourceCount: number;
  musicFile: File | null;
  /** 인터넷에서 "주제 edit"를 찾아 편집 스타일을 배울지 */
  learnOnline: boolean;
  /** 사용자가 올린 참고 에딧 (최대 3개) */
  referenceFiles: File[];
  /** 편집에 쓸 영상을 직접 올린 파일 (주제 없이 이것만으로도 만들 수 있음) */
  uploadFiles?: File[];
  /** 영상을 찾지 않고 올린 영상만 편집 (주제는 제목·스타일·참고 에딧 학습에만 씀) */
  uploadsOnly?: boolean;
  /** 끝에 출처 화면을 붙일지 (배경음악 길이를 맞추려고, 기본 true) */
  showCredits?: boolean;
  /** 직접 입력한 제목 (비우면 주제 이름) */
  title?: string;
  /** 자동 작곡 배경음악 스타일 (내 음악 파일을 넣으면 쓰지 않음) */
  musicStyle?: MusicStyle;
  /** 편집 스타일 직접 설정 (비어 있으면 특징 문장·참고 에딧으로 자동) */
  styleOverrides?: StyleOverrides;
}

export interface TopicResult {
  info: TopicInfo;
  weight: number;
  queries: string[];
  candidates: SourceVideo[];
  reports: SearchReport[];
  /** 제목에 주제 이름이 없어 뺀 영상 수 */
  irrelevant: number;
}

/** 주제별 결과 — 여러 주제 중 일부가 빠졌을 때 이유를 보여 주려고 */
export interface TopicSummary {
  label: string;
  weight: number;
  used: number;
  /** 하나도 못 썼을 때 그 이유 */
  note: string | null;
}

export interface PipelineResult {
  topics: TopicResult[];
  title: string;
  style: EditStyle;
  sources: LoadedSource[];
  plan: EditPlan;
  music: { buffer: AudioBuffer; offset: number };
  credits: string[];
  /** 참고 에딧에서 배운 스타일 (배우지 않았으면 null) */
  profile: StyleProfile | null;
  topicSummary: TopicSummary[];
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
/** 직접 올릴 수 있는 영상 수 */
export const MAX_UPLOADS = 8;
const UPLOAD_LABEL = "내 영상";

export async function runPipeline(input: PipelineInput, events: PipelineEvents, signal: AbortSignal): Promise<PipelineResult> {
  // 특징·분위기에 NSFW를 적었으면 성적 콘텐츠 검열만 끕니다(다른 카테고리는 그대로).
  const policy = { nsfw: isNsfwRequested(input.features) };
  // 검열: 부적절한 단어가 있으면 시작하지 않습니다.
  const blocked = checkUserInput(input.topic, input.features);
  if (blocked) throw new GenerationBlockedError(blocked);
  // 분위기를 직접 골랐으면 그 분위기로 읽고, 나머지 직접 설정은 참고 에딧 학습 뒤에 덮어씁니다(직접 설정이 우선).
  let style = parseStyle(input.features, { mood: input.styleOverrides?.mood });
  const specs = parseTopicInput(input.topic);
  const uploads = (input.uploadFiles ?? []).slice(0, MAX_UPLOADS);
  if (!specs.length && !uploads.length) throw new Error("주제를 입력하거나 편집할 영상을 올려 주세요.");

  if (specs.length) events.step("topic", specs.length > 1 ? `주제 ${specs.length}개를 해석하는 중` : `"${specs[0].term}" 주제를 해석하는 중`);
  const infos = await Promise.all(specs.map(spec => resolveTopic(spec.term, signal, policy)));
  // 검열: 주제가 가리키는 대상(영어 이름, 설명)이 부적절하면 생성하지 않습니다.
  const badTopic = infos.find(info => !isTopicAllowed(info, policy));
  if (badTopic) throw new GenerationBlockedError(`생성 불가 — 주제 "${badTopic.query}"는 검열 대상이에요.`);

  const where = input.licenseMode === "any" ? (input.helper ? "YouTube·Reddit·스톡 영상" : "Reddit·스톡 영상") : "Wikimedia Commons·Internet Archive·스톡 영상";
  const queriesFor = (info: TopicInfo) =>
    input.licenseMode === "any" ? expandQueries(info, style.searchHints).map(q => q.q) : [info.englishLabel ?? info.label, ...(info.related ?? []).slice(0, 3)];
  // "올린 영상만 편집"이면 영상을 찾지 않습니다(올린 영상이 있을 때만).
  const searching = !(input.uploadsOnly && uploads.length);
  const groups = infos.map((info, i) => ({ label: info.label, weight: specs[i].weight, queries: searching ? queriesFor(info) : [] }));
  events.queries(searching ? groups : []);
  const queryCount = groups.reduce((sum, g) => sum + g.queries.length, 0);
  if (specs.length && searching) events.step("search", `${where}에서 ${queryCount}가지 검색어로 찾는 중`);
  const found = searching
    ? await Promise.all(infos.map(info => findSources(info, style.searchHints, input.licenseMode, input.helper, signal, input.stockKeys)))
    : infos.map(() => ({ sources: [] as SourceVideo[], reports: [] as SearchReport[] }));

  // 주제마다 쓸 수 있는 후보를 고릅니다(검열·관련성). 여러 주제에 같은 영상이 걸리면 아래에서 한 주제에만 줍니다.
  const censoredIds = new Set<string>();
  const censored: string[] = [];
  let irrelevant = 0;
  const eligible = infos.map((info, i) => {
    // 검열: 제목·채널·분류에 금지어가 있거나 출처가 성인물로 표시한 영상은 받지 않습니다.
    // NSFW 모드에서는 성적 단어와 성인물 표시를 걸러내지 않습니다.
    const matches = createTopicMatcher(info);
    const flagged = found[i].sources.filter(source => (!policy.nsfw && source.nsfw) || !isTextAllowedWith(policy, source.title, source.author, source.tags));
    // 찾은 영상 중 상당수가 검열 대상이면 주제 자체를 막습니다.
    if (shouldBlockTopic(flagged.length, found[i].sources.length)) {
      const percent = Math.round((flagged.length / found[i].sources.length) * 100);
      throw new GenerationBlockedError(`생성 불가 — "${info.query}"로 찾은 영상의 ${percent}%(${flagged.length}/${found[i].sources.length}개)가 검열 대상이에요.`);
    }
    const flaggedIds = new Set(flagged.map(source => source.id));
    let topicIrrelevant = 0;
    const list = found[i].sources.filter(source => {
      if (flaggedIds.has(source.id)) {
        if (!censoredIds.has(source.id)) {
          censoredIds.add(source.id);
          censored.push(source.id);
          if (!source.nsfw) events.skipped(source, "부적절한 단어가 있어 제외했어요");
        }
        return false;
      }
      // 관련성: 제목·태그·채널에 주제 이름이 나오는 영상(또는 주제의 Commons 분류·대표 영상)만 씁니다.
      if (!source.trusted && !matches([source.title, source.tags, source.author].filter(Boolean).join(" "))) {
        topicIrrelevant++;
        return false;
      }
      return true;
    });
    irrelevant += topicIrrelevant;
    return { list, irrelevant: topicIrrelevant };
  });
  // 겹치는 영상(예: 두 사람이 함께 나오는 영상)은 후보가 더 적은 주제에 줍니다 — 먼저 적은 주제가 통째로 빠지지 않게.
  const owner = new Map<string, number>();
  eligible.forEach(({ list }, i) => {
    for (const source of list) {
      const current = owner.get(source.id);
      if (current === undefined || list.length < eligible[current].list.length) owner.set(source.id, i);
    }
  });
  const topics: TopicResult[] = infos.map((info, i) => ({
    info,
    weight: specs[i].weight,
    queries: groups[i].queries,
    candidates: eligible[i].list.filter(source => owner.get(source.id) === i),
    reports: found[i].reports,
    irrelevant: eligible[i].irrelevant,
  }));
  // 직접 올린 영상은 하나의 "주제"처럼 다룹니다. 주제와 함께 쓰면 편집의 절반을 차지합니다.
  const uploadTopic: TopicResult | null = uploads.length
    ? {
        info: {
          query: UPLOAD_LABEL,
          label: UPLOAD_LABEL,
          englishLabel: null,
          description: null,
          commonsCategory: null,
          wikidataVideos: [],
          // 함께 입력한 주제가 스포츠·인물이면 올린 영상도 같은 기준으로 봅니다(경기 장면 오탐 방지, 사람 위주 장면 선택).
          sports: infos.some(info => info.sports),
          person: infos.some(info => info.person),
        },
        weight: specs.length ? specs.reduce((sum, spec) => sum + spec.weight, 0) : 1,
        queries: [],
        candidates: uploads.map(uploadedSource),
        reports: [],
        irrelevant: 0,
      }
    : null;
  events.candidates([...(uploadTopic?.candidates ?? []), ...topics.flatMap(t => t.candidates)]);
  const online = topics.filter(t => t.candidates.length);
  const active = uploadTopic ? [uploadTopic, ...online] : online;
  if (!active.length) {
    const scope = input.licenseMode === "reusable" ? "재사용 가능한 라이선스의 " : "";
    const details = topics.map(t => (topics.length > 1 ? `[${t.info.label}]\n` : "") + summarizeReports(t.reports)).join("\n\n");
    const censorNote = censored.length ? `\n\n검열: 부적절한 단어가 있는 영상 ${censored.length}개 제외` : "";
    const relevanceNote = irrelevant ? `\n관련성: 제목에 주제 이름이 없는 영상 ${irrelevant}개 제외` : "";
    // Commons 영상은 WebM뿐이라 아이폰 사파리 등에서는 재생할 수 없습니다 — 해결 방법을 함께 알려 줍니다.
    const formatBlocked = topics.some(t => t.reports.some(r => (r.rejected?.[REASON.format] ?? 0) > 0));
    const formatNote = formatBlocked ? "\n\n도움말: 이 브라우저는 WebM 영상을 재생하지 못해요(아이폰 사파리 등). PC나 안드로이드의 Chrome에서 열면 Commons 영상을 쓸 수 있어요." : "";
    const names = topics.map(t => `"${t.info.label}"`).join(", ");
    throw new Error(`${scope}${names} 영상을 찾지 못했어요. 제목에 이름이 나오는 영상만 쓰니, 이름을 정확히(또는 영어로) 입력해 보세요.\n\n${details}${censorNote}${relevanceNote}${formatNote}`);
  }
  const failures: string[] = searching ? topics.filter(t => !t.candidates.length).map(t => `주제 "${t.info.label}": 영상을 찾지 못했어요`) : [];
  if (censored.length) failures.push(`검열: 부적절한 단어가 있는 영상 ${censored.length}개 제외`);
  if (irrelevant) failures.push(`관련성: 제목에 주제 이름이 없는 영상 ${irrelevant}개 제외`);
  // 영상을 받는 동안 장면 검열 모델도 미리 받아 둡니다(NSFW 모드에서는 받지 않음).
  preloadClassifier(policy);

  // 속도: 참고 에딧 학습과 내 음악 분석은 원본 영상 받기·분석과 동시에 진행합니다.
  // 원본 영상 분석은 배운 스타일과 무관하고, 배운 값(템포·컷 리듬)은 하이라이트를 고를 때(꺼낼 때) 반영하므로 결과는 같습니다.
  // 참고 에딧은 영상을 찾은 주제(올린 영상만 편집이면 입력한 주제)로 찾습니다.
  // 주제 없이 올린 영상만 쓰면 인터넷에서 찾을 이름이 없으므로 올린 참고 에딧으로만 배웁니다.
  const named = online.length ? online : searching ? [] : topics;
  const learnTopic = (named.length ? named : active).reduce((a, b) => (b.weight > a.weight ? b : a)).info;
  const learnPromise =
    (input.learnOnline && named.length) || input.referenceFiles.length
      ? learnStyle({ ...input, learnOnline: input.learnOnline && named.length > 0 }, learnTopic, style, policy, events, signal, failures)
      : Promise.resolve(null);
  const musicPromise = input.musicFile ? prepareUserMusic(input.musicFile, input.seconds) : Promise.resolve(null);
  // 다른 곳에서 먼저 실패해 기다리지 못하게 돼도 처리되지 않은 오류로 남지 않게
  learnPromise.catch(() => undefined);
  musicPromise.catch(() => undefined);
  let profile: StyleProfile | null = null;
  let userMusic: Awaited<typeof musicPromise> = null;
  let musicMood: Mood = style.mood;
  // 음악 템포가 정해져야 하이라이트 길이를 정할 수 있습니다(아래에서 학습·음악 분석이 끝나면 정함).
  let bpm = style.bpm;
  let highlightLength = 0;
  let approxCuts = 0;

  // 영상 칸을 주제 비중대로 나눕니다. 주제가 많으면 주제마다 최소 1개는 받습니다.
  // 직접 올린 영상은 모두 쓰고, 검색한 영상 칸은 그만큼 줄입니다(검색 주제가 있으면 최소 2칸).
  const onlineSlots = online.length ? Math.min(Math.max(input.sourceCount, online.length), Math.max(2, MAX_TOTAL_SOURCES - uploads.length)) : 0;
  const slots = uploads.length + onlineSlots;
  const quota = [...(uploadTopic ? [uploads.length] : []), ...(online.length ? allocateSlots(online.map(t => t.weight), onlineSlots) : [])];
  const totalWeight = active.reduce((sum, t) => sum + t.weight, 0);

  const loaded: LoadedSource[] = [];
  const loadedBy = new Map<TopicResult, LoadedSource[]>(active.map(t => [t, []]));
  // 장면 검열 결과(검사한 수, 걸린 수)를 주제별로 셉니다.
  /** 주제별 첫 실패 이유 */
  const topicFailures = new Map<TopicResult, string>();
  const screening = new Map<TopicResult, { checked: number; blocked: number }>(active.map(t => [t, { checked: 0, blocked: 0 }]));
  const cursor = new Map<TopicResult, number>(active.map(t => [t, 0]));

  // 속도: 지금 영상을 쓰는 동안 다음 후보도 미리 받아 분석해 둡니다(휴대폰은 1개, PC는 2개 앞까지).
  // 결과는 원래 순서대로 하나씩 꺼내 판정하므로, 어떤 영상이 쓰이는지는 미리 받지 않을 때와 같습니다.
  const lookahead = isMobile ? 1 : 2;
  interface Prepared {
    url: string;
    analysis: VideoAnalysis;
    verdict: { blocked: boolean; reason: string | null; certain?: boolean };
  }
  interface Job {
    topic: TopicResult;
    candidate: SourceVideo;
    controller: AbortController;
    promise: Promise<Prepared>;
  }
  const queues = new Map<TopicResult, Job[]>(active.map(t => [t, []]));
  let current: Job | null = null;
  const onAbort = () => queues.forEach(queue => queue.forEach(job => job.controller.abort()));
  signal.addEventListener("abort", onAbort);

  /** 이 영상을 스포츠 기준(맨살·몸싸움 오탐 완화)으로 볼지: 주제·특징 문장·영상 제목과 태그 중 하나라도 경기 관련이면 */
  const featureSports = mentionsSports(input.features);
  const isSportsJob = (job: Job) => Boolean(job.topic.info.sports || featureSports || mentionsSports([job.candidate.title, job.candidate.tags].filter(Boolean).join(" ")));

  /** 영상 하나를 받아 분석하고 장면을 검사합니다. 공유 상태는 건드리지 않습니다(판정은 꺼낼 때). */
  const prepare = async (job: Job): Promise<Prepared> => {
    const { candidate, controller } = job;
    const report = (id: StepId, detail: string, ratio?: number) => {
      if (current === job) events.step(id, detail, ratio);
    };
    const label = () => `${loaded.length + 1}/${slots} · ${candidate.title}`;
    report("download", label(), 0);
    const blob = await downloadSource(candidate, ratio => report("download", label(), ratio), controller.signal, LIMITS.sourceBytes);
    const url = URL.createObjectURL(blob);
    try {
      report("analyze", `${candidate.title} 장면 분석 중`, 0);
      const analysis = await analyzeVideo(blob, url, ratio => report("analyze", `${candidate.title} 장면 분석 중`, ratio), controller.signal, LIMITS.analysisSamples);
      // 검열: 실제 장면을 검사해 선정적인 영상은 쓰지 않습니다(NSFW 모드에서는 검사하지 않음).
      if (!policy.nsfw) report("analyze", `${candidate.title} 장면 검열 중`);
      // 스포츠 선수 주제는 경기 중 노출(상의 탈의 등)을 선정성으로 보지 않습니다.
      // 영상 제목·태그가 경기 영상이면(예: 주제는 도시인데 영상은 그 도시 팀 경기) 그 영상도 스포츠 기준으로 봅니다.
      const verdict = await screenFrames(analysis.keyframes, { ...policy, sports: isSportsJob(job) });
      analysis.keyframes = [];
      return { url, analysis, verdict };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  };

  /** 필요한 만큼만(남은 칸 수, 최대 lookahead+1개) 미리 시작합니다 — 쓰지 않을 영상을 받느라 데이터를 낭비하지 않게. */
  const enqueue = (topic: TopicResult, want: number) => {
    const queue = queues.get(topic)!;
    while (queue.length < Math.min(lookahead + 1, want)) {
      const index = cursor.get(topic)!;
      if (index >= topic.candidates.length) return;
      cursor.set(topic, index + 1);
      const controller = new AbortController();
      const job: Job = { topic, candidate: topic.candidates[index], controller, promise: Promise.resolve(null as never) };
      job.promise = prepare(job);
      job.promise.catch(() => undefined); // 꺼내기 전에 실패해도 처리되지 않은 오류로 남지 않게
      queue.push(job);
    }
  };

  /** `want`: 이 주제에서 앞으로 더 필요한 영상 수 (미리 받기 상한) */
  const tryNext = async (topic: TopicResult, perSource: number, want: number): Promise<boolean> => {
    const queue = queues.get(topic)!;
    for (;;) {
      enqueue(topic, Math.max(1, want));
      const job = queue.shift();
      if (!job) return false;
      // 꺼낸 영상이 쓰인다고 보고, 그다음에 필요한 만큼만 미리 시작합니다.
      enqueue(topic, want - 1);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { candidate } = job;
      current = job;
      // 미리 받아 둔 영상이면 진행 상황 표시가 건너뛰어졌으므로 지금 단계를 한 번 알려 줍니다.
      events.step("download", `${loaded.length + 1}/${slots} · ${candidate.title}`);
      let url: string | null = null;
      try {
        const prepared = await job.promise;
        url = prepared.url;
        const { analysis, verdict } = prepared;
        const tally = screening.get(topic)!;
        tally.checked++;
        if (verdict.blocked) {
          // 받아 본 영상 중 상당수에서 부적절한 장면이 나오면 주제 자체를 막습니다.
          // 스포츠 영상은 오탐이 많아서, 확실한 장면이 나온 영상만 주제 전체 차단에 셉니다(나머지는 그 영상만 뺌).
          if (!isSportsJob(job) || verdict.certain) tally.blocked++;
          if (shouldBlockTopic(tally.blocked, tally.checked)) {
            throw new GenerationBlockedError(`생성 불가 — "${topic.info.query}" 영상 ${tally.checked}개 중 ${tally.blocked}개에서 부적절한 장면이 감지됐어요.`);
          }
          throw new Error(verdict.reason ?? "부적절한 장면이 감지되어 제외했어요");
        }
        // 인물 주제는 그 사람이 크게 보이는 순간을 더 높게 칩니다.
        const scores = scoreSamples(analysis.samples, style.weights, topic.info.person ? 0.6 : 0);
        const length = Math.min(highlightLength, analysis.duration * 0.5);
        const highlights = pickHighlights(candidate.id, analysis.samples, scores, length, perSource, analysis.duration);
        if (!highlights.length) throw new Error("쓸 만한 장면이 없었어요.");
        const source: LoadedSource = { ...candidate, duration: analysis.duration, url, analysis, scores, highlights, topicLabel: topic.info.label };
        loaded.push(source);
        loadedBy.get(topic)!.push(source);
        events.loaded(source);
        return true;
      } catch (error) {
        if (url) URL.revokeObjectURL(url);
        if (signal.aborted || error instanceof GenerationBlockedError) throw error;
        const reason = describeError(error);
        failures.push(`${candidate.provider} "${candidate.title.slice(0, 40)}": ${reason}`);
        if (!topicFailures.has(topic)) topicFailures.set(topic, reason);
        events.skipped(candidate, reason);
      } finally {
        current = null;
      }
    }
  };

  /** 쓰지 않게 된 미리 받기 작업을 멈추고 메모리를 돌려줍니다. */
  const discardPrefetched = () => {
    signal.removeEventListener("abort", onAbort);
    for (const queue of queues.values()) {
      for (const job of queue) {
        job.controller.abort();
        job.promise.then(prepared => URL.revokeObjectURL(prepared.url), () => undefined);
      }
      queue.length = 0;
    }
  };

  try {
    const byWeight = active.map((t, i) => ({ t, q: quota[i] })).sort((a, b) => b.t.weight - a.t.weight);
    // 학습·음악 분석을 기다리는 동안 원본 영상을 미리 받아 분석해 둡니다.
    for (const { t, q } of byWeight) enqueue(t, q);

    // 참고 에딧에서 컷 리듬·템포·색감·효과를 배워 스타일에 반영합니다(하이라이트 길이·템포를 정하기 전에).
    profile = await learnPromise;
    style = applyOverrides(applyProfile(style, profile), input.styleOverrides);
    userMusic = await musicPromise;
    // 배경음악 스타일을 고르면 그 장르로 작곡하고, 템포를 직접 정하지 않았으면 장르의 기본 템포로 컷도 맞춥니다.
    musicMood = !input.musicStyle || input.musicStyle === "auto" ? style.mood : input.musicStyle;
    if (!userMusic && musicMood !== style.mood && !style.bpmExplicit && !profile?.bpm) style = { ...style, bpm: defaultBpm(musicMood) };
    bpm = userMusic?.bpm ?? style.bpm;
    highlightLength = requiredHighlightLength(style, bpm);
    approxCuts = Math.ceil(input.seconds / ((60 / bpm) * 2));

    // 1) 주제별 몫을 채웁니다 (비중이 큰 주제부터).
    for (const { t, q } of byWeight) {
      const perSource = Math.ceil((approxCuts * (t.weight / totalWeight)) / Math.max(1, q)) + 2;
      while (loadedBy.get(t)!.length < q && (await tryNext(t, perSource, q - loadedBy.get(t)!.length))) {
        /* 몫을 채울 때까지 */
      }
    }
    // 2) 영상이 모자란 주제가 있으면 남은 칸을 다른 주제의 다음 후보로 채웁니다.
    for (let progress = true; loaded.length < slots && progress; ) {
      progress = false;
      for (const { t } of byWeight) {
        if (loaded.length >= slots) break;
        if (await tryNext(t, Math.ceil(approxCuts / slots) + 2, slots - loaded.length)) progress = true;
      }
    }
  } finally {
    discardPrefetched();
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
        buffer: await synthesizeMusic({ mood: musicMood, bpm, duration: plan.duration + tailSeconds(input.showCredits), dropAt: plan.dropAt, outroAt }),
        offset: 0,
      };

  const used = new Set(plan.segments.map(s => s.sourceId));
  const credits = loaded
    .filter(s => used.has(s.id) && !s.file)
    .map(s => `"${s.title}" — ${s.author} · ${s.license} · ${s.provider}`);
  if (!userMusic) credits.push("Music: generated by editmatker");

  // 올린 영상만 편집하면 입력한 주제 이름을 제목으로 씁니다.
  const titled = searching ? online.filter(t => loadedBy.get(t)!.length) : topics;
  const title = input.title?.trim() || (titled.length ? combinedTitle(titled.map(t => t.info.label)) : UPLOAD_LABEL);
  const topicSummary: TopicSummary[] = [...(uploadTopic ? [uploadTopic] : []), ...(searching ? topics : [])].map(t => {
    const used = loadedBy.get(t)?.length ?? 0;
    let note: string | null = null;
    if (!used) {
      if (!t.candidates.length) {
        const found = t.reports.reduce((sum, r) => sum + r.scanned, 0);
        note = found ? `찾은 영상 ${found}개 중 쓸 수 있는 게 없었어요${t.irrelevant ? ` (제목에 이름이 없는 영상 ${t.irrelevant}개)` : ""}` : "검색 결과가 없었어요";
      } else {
        note = `영상을 불러오지 못했어요 — ${topicFailures.get(t) ?? "알 수 없는 오류"}`;
      }
    }
    return { label: t.info.label, weight: t.weight, used, note };
  });
  return { topics, title, style, sources: loaded, plan, music, credits, profile, topicSummary };
}

/** 참고 에딧(올린 파일 + 인터넷에서 찾은 에딧, 합쳐 최대 3개)을 분석해 스타일 프로필을 만듭니다. 실패해도 생성은 계속합니다. */
async function learnStyle(
  input: PipelineInput,
  topic: TopicInfo,
  style: EditStyle,
  policy: ModerationOptions,
  events: PipelineEvents,
  signal: AbortSignal,
  notes: string[]
): Promise<StyleProfile | null> {
  const items: { title: string; load: () => Promise<Blob> }[] = input.referenceFiles.slice(0, 3).map(file => ({ title: file.name, load: async () => file }));
  if (input.learnOnline && items.length < 3) {
    events.step("learn", `인터넷에서 "${topic.englishLabel ?? topic.label} edit" 찾는 중`);
    const found = await searchReferenceEdits(topic, input.helper, signal).catch(error => {
      if (signal.aborted) throw error;
      return [] as SourceVideo[];
    });
    if (!found.length) notes.push("참고 에딧: 인터넷에서 쓸 만한 에딧을 찾지 못했어요");
    for (const source of found.slice(0, 3 - items.length)) {
      items.push({ title: source.title, load: () => downloadSource(source, ratio => events.step("learn", `참고 에딧 받는 중 · ${source.title}`, ratio), signal, LIMITS.sourceBytes) });
    }
  }
  const references: ReferenceAnalysis[] = [];
  for (const item of items) {
    try {
      events.step("learn", `참고 에딧 분석 중 · ${item.title}`, 0);
      const blob = await item.load();
      references.push(await analyzeReference(blob, item.title, { ...policy, sports: topic.sports || mentionsSports(input.features) }, ratio => events.step("learn", `참고 에딧 분석 중 · ${item.title}`, ratio), signal));
    } catch (error) {
      if (signal.aborted) throw error;
      notes.push(`참고 에딧 "${item.title.slice(0, 40)}": ${describeError(error)}`);
    }
  }
  const profile = buildProfile(references, style.bpm);
  if (profile) events.step("learn", `${describeProfile(profile)}에서 스타일을 배웠어요`);
  return profile;
}
