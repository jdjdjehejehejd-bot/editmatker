// 주제 → 영상 검색 → 다운로드 → 하이라이트 분석 → 편집 계획까지의 전체 흐름입니다.

import { analyzeVideo, type VideoAnalysis } from "./analyze";
import { isMobile, LIMITS } from "./device";
import { isChunkLoadError, OUTDATED_MESSAGE } from "./version";
import { checkUserInput, classifierError, MODEL_FAILED, GenerationBlockedError, type ModerationOptions, isNsfwRequested, isTextAllowedWith, isTopicAllowed, preloadClassifier, screenFrames, shouldBlockTopic } from "./moderation";
import { assessVideo, pickHighlights, scoreSamples, type Highlight } from "./highlights";
import { detectSport, type SportKind } from "./sport";
import { prepareUserMusic, synthesizeMusic } from "./music";
import { buildPlan, requiredHighlightLength, type EditPlan } from "./plan";
import { tailSeconds } from "./render";
import { embed, frameScores, inferTopic, posterFrame, uploadFrames, type InferredTopic } from "./vision";
import { addSimilarity, centroid, cosine, rerankBySimilarity } from "./similarity";
import { sanitizeWeight, uploadGroupWeight } from "./uploads";
import { downloadTrack, findFreeMusic, rememberTrack, trackCredit, type FreeTrack } from "./freemusic";
import { countKeywordHits } from "./style";
import { allocateSlots, combinedTitle, createTopicMatcher, expandQueries, mentionsSports, parseTopicInput } from "./topic";
import type { StockKeys } from "./stock";
import { describeError, downloadSource, findSources, REASON, summarizeReports, resolveTopic, uploadedSource, type LicenseMode, type SearchReport, type SourceVideo, type TopicInfo } from "./sources";
import { applyProfile, buildProfile, describeProfile, type ReferenceAnalysis, type StyleProfile } from "./learn";
import { analyzeReference } from "./reference";
import { searchReferenceEdits } from "./social";
import { applyOverrides, defaultBpm, parseStyle, type EditStyle, type Mood, type MusicStyle, type StyleOverrides } from "./style";

export type StepId = "topic" | "search" | "learn" | "download" | "analyze" | "plan" | "render";

/** 찾을 대상이 하나도 없을 때 분위기에 어울리는 영상 검색어 */
const MOOD_FOOTAGE: Record<Mood, { term: string; label: string }> = {
  hype: { term: "extreme sports", label: "익스트림 스포츠" },
  cinematic: { term: "landscape", label: "풍경" },
  emotional: { term: "sunset", label: "노을" },
  retro: { term: "city night", label: "도시 야경" },
};

/** 거의 멈춘 영상을 건너뛸 때의 이유 */
const STILL_VIDEO = "거의 멈춰 있는 영상(사진 모음·슬라이드쇼)이라 건너뛰었어요";

export interface LoadedSource extends SourceVideo {
  url: string;
  analysis: VideoAnalysis;
  scores: number[];
  highlights: Highlight[];
  /** 이 영상을 찾은 주제 */
  topicLabel: string;
  /** 0~1 영상 전체가 얼마나 살아 있는지 (직접 올린 영상은 1) */
  quality?: number;
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
  /** 올린 파일마다 가중치 (uploadFiles와 같은 순서, 기본 ×1) */
  uploadWeights?: number[];
  /** 영상을 찾지 않고 올린 영상만 편집 (주제는 제목·스타일·참고 에딧 학습에만 씀) */
  uploadsOnly?: boolean;
  /** 끝에 출처 화면을 붙일지 (배경음악 길이를 맞추려고, 기본 true) */
  showCredits?: boolean;
  /** 직접 입력한 제목 (비우면 주제 이름) */
  title?: string;
  /** 배경음악을 무료 음악 사이트(Openverse)에서 찾아 쓸지 (내 음악 파일이 있으면 그걸 씀) */
  freeMusic?: boolean;
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
  /** 이름은 없지만 관련 주제(소속 팀·종목·그룹 등)가 제목에 나오는 영상 — 이름이 나오는 영상만으로 칸이 모자랄 때 채움 */
  related?: SourceVideo[];
  /** 이름도 관련 주제도 안 나오지만 검색에 걸린 영상 — 다른 방법으로도 없을 때만 씀 */
  loose?: SourceVideo[];
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
  /** 무료 음악 사이트에서 가져온 곡 (자동 작곡·내 음악이면 없음) */
  track?: FreeTrack;
  /** 주제를 비웠을 때 올린 영상을 보고 고른 주제 */
  inferredTopic?: InferredTopic;
  /** 주제와 올린 영상을 서로 닮은 쪽으로 맞췄는지 (찾은 영상은 올린 영상과 닮은 순, 올린 영상은 주제와 닮은 장면 우선) */
  matched?: boolean;
  /** 고른 영상 수보다 이름이 나오는 영상이 적어 관련 영상으로 채운 수 */
  relatedUsed?: number;
  /** 고른 영상 수(칸)와 실제로 쓴 수 */
  wanted?: number;
  /** 처음 검색어로 영상이 없어 검색을 넓혔으면 그 설명 */
  broadened?: string;
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
  // 속도: 장면 검열 모델은 어차피 쓰므로 주제 해석·검색과 동시에 미리 받습니다(NSFW 모드면 받지 않음).
  preloadClassifier(policy);
  let specs = parseTopicInput(input.topic);
  const uploads = (input.uploadFiles ?? []).slice(0, MAX_UPLOADS);
  if (!specs.length && !uploads.length && !input.features.trim()) throw new Error("주제를 입력하거나 편집할 영상을 올려 주세요.");
  // 주제를 비웠으면 알아서 고릅니다.
  // 1) 특징·분위기 문장에 나오는 대상(예: "뉴진스 무대 장면 위주로" → 뉴진스)
  // 2) 영상만 올렸으면 올린 영상(파일 이름 → 장면)
  // 고른 주제로 비슷한 영상을 찾아 섞고("올린 영상만 편집"이면 찾지 않음), 제목·장면 판단·스타일 학습에도 씁니다.
  let inferred: InferredTopic | null = null;
  if (!specs.length && input.features.trim()) {
    events.step("topic", "특징·분위기를 보고 주제를 고르는 중");
    inferred = await topicFromFeatures(input.features, style.keywords ?? [], signal, policy);
  }
  if (!specs.length && !inferred && uploads.length) {
    events.step("topic", "올린 영상을 보고 비슷한 주제를 고르는 중");
    inferred = await inferTopic(uploads, signal).catch(error => {
      if (signal.aborted) throw error;
      return null;
    });
    if (inferred && checkUserInput(inferred.term, "")) inferred = null;
  }
  if (!specs.length && inferred) {
    // 하나로 정하지 않고: 공통으로 나오는 대상은 모두 주제로(같은 비중), 일반적인 특징은 함께 검색·우선할 낱말로 씁니다.
    const allowed = [inferred, ...(inferred.also ?? [])].filter(t => !checkUserInput(t.term, ""));
    specs = allowed.map(t => ({ term: t.term, weight: 1 }));
    const traits = (inferred.traits ?? []).filter(word => !checkUserInput(word, ""));
    if (traits.length) {
      style = {
        ...style,
        searchHints: [...new Set([...traits, ...style.searchHints])].slice(0, 4),
        keywords: [...new Set([...(style.keywords ?? []), ...traits])],
      };
    }
  }
  /** 검색을 넓힌 방법 (결과에 알려 줌) */
  let broadened: string | null = null;
  const addNote = (note: string) => (broadened = broadened ? `${broadened} · ${note}` : note);
  let moodFallback: { term: string; label: string } | null = null;
  if (!specs.length && !uploads.length) {
    // 스타일만 적어 찾을 대상이 없어도 멈추지 않고, 분위기에 어울리는 영상(풍경·도시 야경 등)으로 만듭니다.
    const fallback = MOOD_FOOTAGE[style.mood];
    moodFallback = fallback;
    specs = [{ term: fallback.term, weight: 1 }];
    broadened = `찾을 대상이 없어 분위기에 어울리는 ${fallback.label} 영상으로 만들었어요 — 인물·대상을 적으면 그걸로 찾아요`;
  }

  if (specs.length) events.step("topic", specs.length > 1 ? `주제 ${specs.length}개를 해석하는 중` : `"${specs[0].term}" 주제를 해석하는 중`);
  const infos = await Promise.all(specs.map(spec => resolveTopic(spec.term, signal, policy)));
  // 분위기로 고른 영상은 우리말 이름을 제목에 씁니다(영어 검색어는 다른 이름으로 남김).
  if (moodFallback && infos[0]) {
    infos[0].aliases = [...new Set([infos[0].label, ...(infos[0].aliases ?? [])])];
    infos[0].label = moodFallback.label;
  }
  // 장면으로 고른 주제는 우리말 이름("강아지")을 제목에 쓰고, Wikidata 이름("개")은 다른 이름으로 남겨 검색·관련성에 씁니다.
  if (inferred?.source === "vision") {
    [inferred, ...(inferred.also ?? [])].forEach((picked, i) => {
      const info = infos[i];
      if (!info) return;
      if (info.label !== picked.label) info.aliases = [...new Set([info.label, ...(info.aliases ?? [])])];
      info.label = picked.label;
    });
  }
  // 검열: 주제가 가리키는 대상(영어 이름, 설명)이 부적절하면 생성하지 않습니다.
  const badTopic = infos.find(info => !isTopicAllowed(info, policy));
  if (badTopic) throw new GenerationBlockedError(`생성 불가 — 주제 "${badTopic.query}"는 검열 대상이에요.`);

  const where = input.licenseMode === "any" ? (input.helper ? "YouTube·Reddit·스톡 영상" : "Reddit·스톡 영상") : "Wikimedia Commons·Internet Archive·스톡 영상";
  const queriesFor = (info: TopicInfo) =>
    input.licenseMode === "any" ? expandQueries(info, style.searchHints).map(q => q.q) : [info.englishLabel ?? info.label, ...(info.related ?? []).slice(0, 3)];
  // "올린 영상만 편집"이면 영상을 찾지 않습니다(올린 영상이 있을 때만).
  const searching = !(input.uploadsOnly && uploads.length);

  // 주제마다 쓸 수 있는 후보를 고릅니다(검열·관련성). 여러 주제에 같은 영상이 걸리면 아래에서 한 주제에만 줍니다.
  const censoredIds = new Set<string>();
  const censored: string[] = [];
  let irrelevant = 0;
  const shownGroups: QueryGroup[] = [];
  /** 주제들을 검색하고 검열·관련성으로 거릅니다. 결과가 없으면 아래에서 검색을 넓혀 다시 부릅니다. */
  const searchTopics = async (list: { info: TopicInfo; weight: number }[], detail?: string): Promise<TopicResult[]> => {
    const groups = list.map(({ info, weight }) => ({ label: info.label, weight, queries: searching ? queriesFor(info) : [] }));
    shownGroups.push(...(searching ? groups : []));
    events.queries([...shownGroups]);
    const queryCount = groups.reduce((sum, g) => sum + g.queries.length, 0);
    if (list.length && searching) events.step("search", detail ?? `${where}에서 ${queryCount}가지 검색어로 찾는 중`);
    const found = searching
      ? await Promise.all(list.map(({ info }) => findSources(info, style.searchHints, input.licenseMode, input.helper, signal, input.stockKeys)))
      : list.map(() => ({ sources: [] as SourceVideo[], reports: [] as SearchReport[] }));
    const eligible = list.map(({ info }, i) => {
      // 검열: 제목·채널·분류에 금지어가 있거나 출처가 성인물로 표시한 영상은 받지 않습니다.
      // NSFW 모드에서는 성적 단어와 성인물 표시를 걸러내지 않습니다.
      const matches = createTopicMatcher(info);
      // 관련 주제(소속 팀·종목·그룹·대표작 등)가 제목에 나오는지 — 이름이 나오는 영상이 모자랄 때만 씁니다.
      const relatedMatches = info.related?.length ? createTopicMatcher({ ...info, query: "", label: "", englishLabel: null, aliases: info.related }) : null;
      const related: SourceVideo[] = [];
      // 이름도 관련 주제도 안 나오지만 검색에는 걸린 영상 — 다른 방법으로도 영상이 없을 때만 씁니다.
      const loose: SourceVideo[] = [];
      const flagged = found[i].sources.filter(source => (!policy.nsfw && source.nsfw) || !isTextAllowedWith(policy, source.title, source.author, source.tags));
      // 찾은 영상 중 상당수가 검열 대상이면 주제 자체를 막습니다.
      if (shouldBlockTopic(flagged.length, found[i].sources.length)) {
        const percent = Math.round((flagged.length / found[i].sources.length) * 100);
        throw new GenerationBlockedError(`생성 불가 — "${info.query}"로 찾은 영상의 ${percent}%(${flagged.length}/${found[i].sources.length}개)가 검열 대상이에요.`);
      }
      const flaggedIds = new Set(flagged.map(source => source.id));
      let topicIrrelevant = 0;
      const named = found[i].sources.filter(source => {
        if (flaggedIds.has(source.id)) {
          if (!censoredIds.has(source.id)) {
            censoredIds.add(source.id);
            censored.push(source.id);
            if (!source.nsfw) events.skipped(source, "부적절한 단어가 있어 제외했어요");
          }
          return false;
        }
        // 관련성: 제목·태그·채널에 주제 이름이 나오는 영상(또는 주제의 Commons 분류·대표 영상)만 씁니다.
        const text = [source.title, source.tags, source.author].filter(Boolean).join(" ");
        if (!source.trusted && !matches(text)) {
          topicIrrelevant++;
          if (relatedMatches?.(text)) related.push(source);
          else loose.push(source);
          return false;
        }
        return true;
      });
      irrelevant += topicIrrelevant;
      // 특징 문장의 키워드(골, 덩크, 무대 등)가 제목·태그에 나오는 영상을 먼저 씁니다(원래 순서는 유지).
      const keywordHits = (source: SourceVideo) => countKeywordHits([source.title, source.tags].filter(Boolean).join(" "), style.keywords ?? []);
      const byKeyword = (items: SourceVideo[]) => (style.keywords?.length ? items.map((s, k) => ({ s, k, h: keywordHits(s) })).sort((a, b) => b.h - a.h || a.k - b.k).map(e => e.s) : items);
      return { list: byKeyword(named), related: byKeyword(related), loose: byKeyword(loose), irrelevant: topicIrrelevant };
    });
    // 겹치는 영상(예: 두 사람이 함께 나오는 영상)은 후보가 더 적은 주제에 줍니다 — 먼저 적은 주제가 통째로 빠지지 않게.
    const owner = new Map<string, number>();
    eligible.forEach(({ list: items }, i) => {
      for (const source of items) {
        const current = owner.get(source.id);
        if (current === undefined || items.length < eligible[current].list.length) owner.set(source.id, i);
      }
    });
    return list.map(({ info, weight }, i) => ({
      info,
      weight,
      queries: groups[i].queries,
      candidates: eligible[i].list.filter(source => owner.get(source.id) === i),
      reports: found[i].reports,
      irrelevant: eligible[i].irrelevant,
      related: eligible[i].related.filter(source => !owner.has(source.id)),
      loose: eligible[i].loose.filter(source => !owner.has(source.id)),
    }));
  };

  const topics: TopicResult[] = await searchTopics(infos.map((info, i) => ({ info, weight: specs[i].weight })));
  // 검색 결과가 없다고 멈추지 않습니다 — 넓혀 가며 다시 찾습니다.
  const hasUsable = () => topics.some(t => t.candidates.length || t.related?.length);
  if (searching && !hasUsable()) {
    // 1) 다른 검색어: 주제의 관련 주제(소속 팀·그룹·종목 등)와 특징·분위기 키워드를 각각 주제로 찾습니다.
    const tried = new Set(topics.map(t => t.info.query.toLowerCase()));
    const featureText = input.features.toLowerCase();
    const alternatives = [
      ...topics.flatMap(t => (t.info.related ?? []).slice(0, 2)),
      ...(style.keywords ?? []).filter(word => word.length >= 2 && featureText.includes(word.toLowerCase())),
    ]
      .filter(term => term && !tried.has(term.toLowerCase()) && !checkUserInput(term, ""))
      .filter((term, i, list) => list.findIndex(other => other.toLowerCase() === term.toLowerCase()) === i)
      .slice(0, 4);
    if (alternatives.length) {
      const altInfos = (await Promise.all(alternatives.map(term => resolveTopic(term, signal, policy)))).filter(info => isTopicAllowed(info, policy));
      const more = await searchTopics(
        altInfos.map(info => ({ info, weight: 1 })),
        `결과가 없어 다른 검색어(${altInfos.map(info => info.label).join(", ")})로 넓혀 찾는 중`
      );
      if (more.some(t => t.candidates.length || t.related?.length)) addNote(`"${topics.map(t => t.info.label).join(", ")}" 영상이 없어 ${more.filter(t => t.candidates.length || t.related?.length).map(t => `"${t.info.label}"`).join(", ")}(으)로 넓혀 찾았어요`);
      topics.push(...more);
    }
  }
  if (searching && !hasUsable()) {
    // 2) 그래도 없으면 조건을 풉니다: 검색에 걸렸지만 제목에 이름이 없어 뺐던 영상을 씁니다(부적절한 영상은 계속 제외).
    for (const t of topics) if (t.loose?.length) t.candidates = t.loose.map(source => ({ ...source, relatedOnly: true }));
    if (hasUsable()) addNote("제목에 이름이 나오는 영상이 없어, 검색에 걸린 영상 중 가까운 것으로 만들었어요");
  }
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
        // 모두 ×1이면 찾은 영상과 반반, 가중치를 올리면 올린 영상 쪽 비중이 커집니다.
        // ×1 = 찾은 영상 하나와 같은 비중. 여기서는 고른 영상 수로 어림하고, 실제로 받은 수로 아래에서 다시 맞춥니다.
        weight: uploadGroupWeight(
          specs.reduce((sum, spec) => sum + spec.weight, 0),
          uploads.map((_, i) => sanitizeWeight(input.uploadWeights?.[i] ?? 1)),
          searching && specs.length ? input.sourceCount : 0
        ),
        queries: [],
        // 가중치가 큰 파일부터 받아, 칸이 모자라도 중요한 영상이 먼저 들어가게 합니다.
        candidates: uploads
          .map((file, i) => uploadedSource(file, i, sanitizeWeight(input.uploadWeights?.[i] ?? 1)))
          .sort((a, b) => (b.uploadWeight ?? 1) - (a.uploadWeight ?? 1)),
        reports: [],
        irrelevant: 0,
      }
    : null;
  events.candidates([...(uploadTopic?.candidates ?? []), ...topics.flatMap(t => t.candidates)]);
  // 이름이 나오는 영상이 없어도 관련 영상이 있으면 그 주제를 씁니다(관련 영상은 아래에서 칸이 모자랄 때만 받음).
  const online = topics.filter(t => t.candidates.length || t.related?.length);
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
  // 주제와 올린 영상을 함께 쓰면 서로 닮은 쪽으로 맞춥니다.
  // 1) 올린 영상의 장면으로 "올린 영상다운 모습"을 만들고, 찾은 영상은 썸네일이 그와 닮은 순으로 앞당깁니다.
  // 2) 찾은 영상 썸네일로 "주제다운 모습"을 만들어, 올린 영상 안에서는 그와 닮은 장면을 조금 더 높게 칩니다.
  // 썸네일을 읽을 수 없거나(CORS) 모델을 못 받으면 하지 않고 그대로 진행합니다.
  let uploadProfile: Float32Array | null = null;
  let topicProfile: Float32Array | null = null;
  if (uploadTopic && searching && online.length) {
    events.step("search", "올린 영상과 닮은 영상을 고르는 중");
    try {
      // 속도: 올린 영상 장면 뽑기와 모든 주제의 썸네일 받기를 동시에 하고, 모델은 한 번(배치)만 돌립니다.
      const tops = online.map(t => t.candidates.slice(0, 12));
      const [mine, posters] = await Promise.all([
        uploadFrames(uploads, signal),
        Promise.all(tops.map(top => Promise.all(top.map(c => (c.poster ? posterFrame(c.poster) : Promise.resolve(null)))))),
      ]);
      const readable = posters.map(list => list.map((p, i) => (p ? i : -1)).filter(i => i >= 0));
      const vectors = await embed([...mine, ...readable.flatMap((idx, t) => idx.map(i => posters[t][i]!))]);
      uploadProfile = centroid(vectors.slice(0, mine.length));
      let offset = mine.length;
      const topicVectors: Float32Array[] = [];
      online.forEach((t, ti) => {
        const own = vectors.slice(offset, offset + readable[ti].length);
        offset += readable[ti].length;
        topicVectors.push(...own);
        if (!uploadProfile) return;
        const profile = uploadProfile;
        const similarity = new Map(readable[ti].map((i, k) => [tops[ti][i].id, cosine(own[k], profile)]));
        t.candidates = [...rerankBySimilarity(tops[ti], c => similarity.get(c.id) ?? null), ...t.candidates.slice(12)];
      });
      topicProfile = centroid(topicVectors);
    } catch (error) {
      if (signal.aborted) throw error;
      uploadProfile = topicProfile = null;
    }
  }
  const failures: string[] = searching ? topics.filter(t => !t.candidates.length).map(t => `주제 "${t.info.label}": 영상을 찾지 못했어요`) : [];
  if (censored.length) failures.push(`검열: 부적절한 단어가 있는 영상 ${censored.length}개 제외`);
  if (irrelevant) failures.push(`관련성: 제목에 주제 이름이 없는 영상 ${irrelevant}개 제외`);

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
  // 무료 음악: 고른 음악 스타일(자동이면 특징 문장의 분위기)로 찾아 받고, 내 음악 파일처럼 박자·드롭을 분석합니다.
  // 못 찾거나 받지 못하면 자동 작곡으로 만듭니다.
  let track: FreeTrack | undefined;
  const musicPromise = input.musicFile
    ? prepareUserMusic(input.musicFile, input.seconds)
    : input.freeMusic
      ? (async () => {
          const mood = !input.musicStyle || input.musicStyle === "auto" ? style.mood : input.musicStyle;
          const tracks = await findFreeMusic(mood, input.seconds + tailSeconds(input.showCredits), signal).catch(error => {
            if (signal.aborted) throw error;
            failures.push(`무료 음악: ${describeError(error)}`);
            return [] as FreeTrack[];
          });
          for (const candidate of tracks.slice(0, 3)) {
            try {
              const prepared = await prepareUserMusic(await downloadTrack(candidate, signal), input.seconds);
              track = candidate;
              // 다음에는 다른 곡이 먼저 나오게 기억해 둡니다.
              rememberTrack(candidate.id);
              return prepared;
            } catch (error) {
              if (signal.aborted) throw error;
            }
          }
          failures.push("무료 음악: 맞는 곡을 받지 못해 자동 작곡으로 만들었어요");
          return null;
        })()
      : Promise.resolve(null);
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
    /** 검열용 장면마다 상대편(올린 영상 ↔ 주제)과 닮은 정도 */
    sims?: number[];
    /** 검열용 장면마다 특징 문장이 말한 대상(바다·자동차·무대 등)이 보이는 정도 */
    subjects?: number[];
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
  /** 종목(격투기·구기·레이싱): 주제 설명·이름·관련 주제·특징 문장·영상 제목으로 알아보고, 스포츠인데 모르면 일반 스포츠 */
  const sportOf = (job: Job): SportKind | null => {
    const info = job.topic.info;
    const kind = detectSport(info.query, info.label, info.englishLabel, info.description, (info.related ?? []).join(" "), input.features, job.candidate.title, job.candidate.tags);
    return kind ?? (isSportsJob(job) ? "general" : null);
  };

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
      const analysis = await analyzeVideo(blob, url, ratio => report("analyze", `${candidate.title} 장면 분석 중`, ratio), controller.signal, LIMITS.analysisSamples * (slots <= 2 ? 2 : 1), undefined, true);
      // 검열: 실제 장면을 검사해 선정적인 영상은 쓰지 않습니다(NSFW 모드에서는 검사하지 않음).
      if (!policy.nsfw) report("analyze", `${candidate.title} 장면 검열 중`);
      // 스포츠 선수 주제는 경기 중 노출(상의 탈의 등)을 선정성으로 보지 않습니다.
      // 영상 제목·태그가 경기 영상이면(예: 주제는 도시인데 영상은 그 도시 팀 경기) 그 영상도 스포츠 기준으로 봅니다.
      const verdict = await screenFrames(analysis.keyframes, { ...policy, sports: isSportsJob(job) });
      // 주제와 올린 영상을 함께 쓰면: 찾은 영상은 올린 영상과, 올린 영상은 주제(찾은 영상들)와 닮은 장면을 잽니다.
      const target = candidate.file ? topicProfile : uploadProfile;
      // 특징 문장이 "바다, 무대"처럼 찍힌 대상을 말했으면 그 대상이 보이는 장면도 잽니다.
      // 속도: 닮은 정도와 대상을 모델 한 번으로 함께 잽니다.
      const terms = style.scene?.subjects ?? [];
      const none = { sims: undefined, subjects: undefined };
      const { sims, subjects } = verdict.blocked ? none : await frameScores(analysis.keyframes, target, terms, cosine).catch(() => none);
      analysis.keyframes = [];
      return { url, analysis, verdict, sims, subjects };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  };

  /** 필요한 만큼만(남은 칸 수, 최대 lookahead+1개) 미리 시작합니다 — 쓰지 않을 영상을 받느라 데이터를 낭비하지 않게. */
  // 같은 출처에서 받기가 연달아 실패하면(예: Reddit 영상 서버가 막힘) 그 출처의 나머지는 받지 않고 건너뜁니다 —
  // 모두 같은 이유로 실패해 시간과 데이터만 쓰지 않게. 한 번이라도 받아지면 다시 셉니다.
  const failStreak = new Map<string, number>();
  /** 거의 멈춘 영상이라 건너뛴 후보 — 다른 영상으로 칸을 다 못 채우면 마지막에 씁니다 */
  const stillBackups = new Map<TopicResult, SourceVideo[]>();
  const blockedProviders = new Map<string, string>();
  const isDownloadFailure = (reason: string) => reason.startsWith("다운로드 실패") || reason.includes("접속이 막혔어요");

  const enqueue = (topic: TopicResult, want: number) => {
    const queue = queues.get(topic)!;
    while (queue.length < Math.min(lookahead + 1, want)) {
      const index = cursor.get(topic)!;
      if (index >= topic.candidates.length) return;
      cursor.set(topic, index + 1);
      const blockedReason = blockedProviders.get(topic.candidates[index].provider);
      if (blockedReason) {
        events.skipped(topic.candidates[index], `${topic.candidates[index].provider}에서 계속 같은 이유로 받지 못해 건너뛰었어요 (${blockedReason})`);
        continue;
      }
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
        const { analysis, verdict, sims, subjects } = prepared;
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
        // 특징 문장이 말하는 장면(밝기·동작 세기·함성·얼굴·화려함)과 찍힌 대상, 상대편과 닮은 정도를 함께 반영합니다.
        // 종목에 맞는 핵심 순간: 격투기는 공격·연타, 구기는 드리블·슛 뒤 함성, 레이싱은 속도감(카메라 이동까지 움직임으로)
        const sport = sportOf(job);
        let scores = scoreSamples(analysis.samples, style.weights, topic.info.person ? 0.6 : 0, style.scene, { cameraMotion: sport === "racing" });
        if (sims && analysis.keyframeTimes) scores = addSimilarity(scores, analysis.samples, analysis.keyframeTimes, sims);
        if (subjects && analysis.keyframeTimes) scores = addSimilarity(scores, analysis.samples, analysis.keyframeTimes, subjects, 0.35);
        const length = Math.min(highlightLength, analysis.duration * 0.5);
        // 가중치가 큰 올린 영상은 더 자주 나오므로 하이라이트도 그만큼 더 뽑아 같은 장면 반복을 줄입니다.
        const count = candidate.uploadWeight ? Math.ceil(perSource * candidate.uploadWeight) : perSource;
        // 스포츠 영상은 펀치·슛 같은 결정적 순간이 있는 구간을 우선합니다(걷기·세리머니·견제만 하는 장면은 뒤로).
        const highlights = pickHighlights(candidate.id, analysis.samples, scores, length, count, analysis.duration, { preferImpact: isSportsJob(job) || Boolean(style.scene?.impact), sport });
        if (!highlights.length) throw new Error("쓸 만한 장면이 없었어요.");
        // 의미 없는 장면만 나열되지 않게: 거의 내내 멈춘 영상(사진 모음·슬라이드쇼·배경화면 영상)은
        // 다른 후보가 남아 있으면 건너뜁니다(직접 올린 영상은 그대로 씀). 쓰더라도 덜 살아 있는 영상은 덜 나오게 합니다.
        const quality = assessVideo(analysis.overview ?? analysis.samples);
        const others = cursor.get(topic)! < topic.candidates.length || queues.get(topic)!.length > 0;
        if (!candidate.file && quality.still && !candidate.allowStill && others) {
          // 칸이 끝내 모자라면 맨 끝에 다시 쓸 수 있게 남겨 둡니다.
          stillBackups.set(topic, [...(stillBackups.get(topic) ?? []), candidate]);
          throw new Error(STILL_VIDEO);
        }
        const source: LoadedSource = { ...candidate, duration: analysis.duration, url, analysis, scores, highlights, topicLabel: topic.info.label, quality: candidate.file ? 1 : quality.score };
        failStreak.set(candidate.provider, 0);
        loaded.push(source);
        loadedBy.get(topic)!.push(source);
        events.loaded(source);
        return true;
      } catch (error) {
        if (url) URL.revokeObjectURL(url);
        if (signal.aborted || error instanceof GenerationBlockedError) throw error;
        // 같은 출처가 막혀서 미리 받기를 멈춘 영상은 그 이유로 건너뜁니다.
        const blockedReason = job.controller.signal.aborted ? blockedProviders.get(candidate.provider) : undefined;
        if (blockedReason) {
          events.skipped(candidate, `${candidate.provider}에서 계속 같은 이유로 받지 못해 건너뛰었어요 (${blockedReason})`);
          continue;
        }
        const reason = describeError(error);
        // 거의 멈춘 영상은 마지막에 쓸 수도 있으니, 끝까지 안 쓰였을 때만 "건너뛴 영상"에 알립니다(아래).
        if (reason === STILL_VIDEO) continue;
        failures.push(`${candidate.provider} "${candidate.title.slice(0, 40)}": ${reason}`);
        if (!topicFailures.has(topic)) topicFailures.set(topic, reason);
        events.skipped(candidate, reason);
        if (isDownloadFailure(reason) && !candidate.file) {
          const streak = (failStreak.get(candidate.provider) ?? 0) + 1;
          failStreak.set(candidate.provider, streak);
          if (streak >= 3 && !blockedProviders.has(candidate.provider)) {
            blockedProviders.set(candidate.provider, reason.replace(/^다운로드 실패: /, ""));
            // 이미 미리 받기 시작한 같은 출처 영상도 멈춥니다(다른 출처 영상은 계속).
            for (const list of queues.values())
              for (const queued of list) if (queued.candidate.provider === candidate.provider) queued.controller.abort();
          }
        }
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
    // 3) 그래도 모자라면(제목에 이름이 나오는 영상이 적을 때) 관련 주제가 제목에 나오는 영상으로 채웁니다.
    //    예전에는 여기서 멈춰서, 영상을 여러 개 고르게 해도 1개만 쓰는 일이 있었습니다.
    // 4) 그래도 모자라면 거의 멈춘 영상이라 건너뛴 것도 씁니다(영상 수를 줄이기보다는 낫게, 비중은 낮게).
    for (const phase of ["named", "related", "still"] as const) {
      if (phase !== "named") {
        if (loaded.length >= slots) break;
        for (const { t } of byWeight) {
          const extra = phase === "related" ? (t.related ?? []).map(source => ({ ...source, relatedOnly: true })) : (stillBackups.get(t) ?? []).map(source => ({ ...source, allowStill: true }));
          if (extra.length) t.candidates = [...t.candidates, ...extra];
        }
      }
      for (let progress = true; loaded.length < slots && progress; ) {
        progress = false;
        for (const { t } of byWeight) {
          if (loaded.length >= slots) break;
          if (await tryNext(t, Math.ceil(approxCuts / slots) + 2, slots - loaded.length)) progress = true;
        }
      }
    }
  } finally {
    discardPrefetched();
  }
  const usedIds = new Set(loaded.map(s => s.id));
  for (const list of stillBackups.values()) for (const source of list) if (!usedIds.has(source.id)) events.skipped(source, STILL_VIDEO);

  if (!loaded.length) {
    const more = failures.length > 6 ? `\n…외 ${failures.length - 6}개` : "";
    // 검열 모델을 못 불러와서 뺀 것이면 영상 문제가 아니므로 그 이유를 먼저 알려 줍니다.
    // (배포 전에 열어 둔 페이지는 새 버전의 파일을 받지 못하는 경우가 많아 새로고침을 권합니다.)
    if (failures.some(line => line.endsWith(MODEL_FAILED))) {
      throw new Error(
        isChunkLoadError(classifierError)
          ? OUTDATED_MESSAGE
          : `부적절한 장면을 검사하는 모델을 불러오지 못해서 영상을 쓰지 못했어요. 인터넷 연결을 확인하고 새로고침한 뒤 다시 시도해 주세요.\n\n${failures.slice(0, 6).join("\n")}${more}`
      );
    }
    // 올린 영상만 썼으면 검색 이야기가 아니라 올린 파일의 문제를 알려 줍니다.
    const lead = online.length
      ? "찾은 영상을 불러오지 못했어요. 잠시 후 다시 시도하거나 다른 주제를 입력해 보세요."
      : "올린 영상을 쓰지 못했어요. 이 브라우저에서 재생되는 영상(mp4·webm, 2초 이상)인지 확인해 주세요. 휴대폰 고화질(HEVC) 영상은 열리지 않을 수 있어요 — 카메라 설정에서 '호환성 우선'으로 찍거나 다른 영상으로 시도해 보세요.";
    throw new Error(`${lead}\n\n${failures.slice(0, 6).join("\n")}${more}`);
  }

  // 편집에서 각 주제가 비중만큼 나오도록, 주제 비중을 그 주제의 영상 수로 나눠 영상마다 나눠 줍니다.
  // 올린 영상의 비중을 실제로 받은 찾은 영상 수로 다시 맞춥니다(×1 = 찾은 영상 하나와 같은 비중).
  if (uploadTopic) {
    const onlineUsed = active.filter(t => t !== uploadTopic && loadedBy.get(t)!.length);
    const onlineCount = onlineUsed.reduce((sum, t) => sum + loadedBy.get(t)!.length, 0);
    uploadTopic.weight = uploadGroupWeight(
      onlineUsed.reduce((sum, t) => sum + t.weight, 0),
      loadedBy.get(uploadTopic)!.map(s => s.uploadWeight ?? 1),
      onlineCount
    );
  }
  const usedWeight = active.filter(t => loadedBy.get(t)!.length).reduce((sum, t) => sum + t.weight, 0);
  for (const t of active) {
    const sources = loadedBy.get(t)!;
    // 주제 안에서는 영상마다 똑같이, 올린 영상은 파일 가중치 비율대로 나눕니다.
    // 같은 주제 안에서 덜 살아 있는 영상은 덜 나오게(최소 30%). 주제 안에서 나누므로 주제 전체의 비중은 그대로입니다.
    const share = (source: LoadedSource) => (source.uploadWeight ?? 1) * (0.3 + 0.7 * (source.quality ?? 1));
    const sourceWeightSum = sources.reduce((sum, s) => sum + share(s), 0);
    for (const source of sources) for (const h of source.highlights) h.weight = ((t.weight / usedWeight) * share(source)) / sourceWeightSum;
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
        // 만들 때마다 다른 곡이 되도록 씨앗을 새로 뽑습니다(분위기·템포·드롭 위치는 그대로).
        buffer: await synthesizeMusic({ mood: musicMood, bpm, duration: plan.duration + tailSeconds(input.showCredits), dropAt: plan.dropAt, outroAt, seed: Math.random() }),
        offset: 0,
      };

  const used = new Set(plan.segments.map(s => s.sourceId));
  const credits = loaded
    .filter(s => used.has(s.id) && !s.file)
    .map(s => `"${s.title}" — ${s.author} · ${s.license} · ${s.provider}`);
  // CC 음악은 작성자·라이선스 표기가 조건이라, 출처 화면이 영상 8개까지만 보여 줘도 빠지지 않게 맨 앞에 둡니다.
  if (track) credits.unshift(trackCredit(track));
  else if (!userMusic) credits.push("Music: generated by editmatker");

  // 제목: 입력한 주제 그대로 씁니다 — 해석한 이름(Wikidata)이 엉뚱하거나, 영상이 없어 넓혀 찾은 다른 대상
  // (관련 선수·특징 낱말)이 제목이 되지 않게. 알아서 고른 주제는 고른 이름(우리말)을 씁니다.
  const primary = topics.slice(0, infos.length);
  const nameOf = (t: TopicResult, i: number) => (inferred || moodFallback ? t.info.label : specs[i].term.trim() || t.info.label);
  const withVideos = primary.map((t, i) => ({ t, i })).filter(({ t }) => !searching || loadedBy.get(t)?.length);
  const titled = (withVideos.length ? withVideos : primary.map((t, i) => ({ t, i }))).map(({ t, i }) => nameOf(t, i));
  const title = input.title?.trim() || (titled.length ? combinedTitle(titled) : UPLOAD_LABEL);
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
  return { topics, title, style, sources: loaded, plan, music, credits, profile, topicSummary, track, inferredTopic: inferred ?? undefined, matched: Boolean(uploadProfile || topicProfile), relatedUsed: loaded.filter(s => s.relatedOnly).length, wanted: slots, broadened: broadened ?? undefined };
}

/** 구체적인 대상(사람·그룹·팀·장소·작품·브랜드)인지 — 이런 대상은 주제로, 아닌 말(무대·바다·골)은 공통 특징으로 씁니다 */
const SPECIFIC_ENTITY = /group|band|duo|team|club|league|city|country|province|island|singer|rapper|actor|actress|player|footballer|athlete|idol|film|movie|series|drama|anime|video game|game|company|brand|album|song|festival|tournament|그룹|밴드|팀|구단|리그|도시|나라|국가|섬|가수|래퍼|배우|선수|아이돌|영화|드라마|애니|게임|회사|기업|브랜드|앨범|노래|축제|대회/i;

/**
 * 특징·분위기 문장에서 주제와 공통 특징을 고릅니다. 하나로 정하지 않고:
 * - 문장의 내용 키워드(스타일 낱말·일반적인 말 제외) 가운데 실제로 적힌 말만 후보(두 글자 이상 먼저, 앞에 나온 순서, 최대 4개)
 * - Wikidata에서 찾아지는 구체적인 대상(사람·그룹·팀·장소 등)은 모두 주제(최대 3개)
 * - 나머지(일반적인 말, 못 찾은 말)는 공통 특징 — 주제와 함께 검색하고 제목에 나오면 우선
 * 구체적인 대상이 없으면 처음 찾아지는 말을 주제로. 하나도 찾아지지 않으면 null.
 */
async function topicFromFeatures(features: string, keywords: string[], signal: AbortSignal, policy: ModerationOptions): Promise<InferredTopic | null> {
  const text = features.toLowerCase();
  const candidates = keywords
    .filter(word => text.includes(word.toLowerCase()) && !checkUserInput(word, ""))
    .map((word, index) => ({ word, index }))
    .sort((a, b) => Number(b.word.length >= 2) - Number(a.word.length >= 2) || a.index - b.index)
    .slice(0, 4)
    .map(entry => entry.word);
  if (!candidates.length) return null;
  const infos = await Promise.all(
    candidates.map(word =>
      resolveTopic(word, signal, policy).catch(error => {
        if (signal.aborted) throw error;
        return null;
      })
    )
  );
  const found = candidates
    .map((word, i) => ({ word, info: infos[i] }))
    .filter((entry): entry is { word: string; info: TopicInfo } => Boolean(entry.info && isTopicAllowed(entry.info, policy) && (entry.info.englishLabel || entry.info.description)));
  // Wikidata에 없는 말이어도 멈추지 않고 그 낱말 그대로 검색합니다(첫 말이 주제, 나머지는 공통 특징).
  if (!found.length) return { term: candidates[0], label: candidates[0], source: "features", confidence: 0.5, traits: candidates.slice(1) };
  const isSpecific = (info: TopicInfo) => Boolean(info.person || info.sports || SPECIFIC_ENTITY.test(info.description ?? ""));
  const specific = found.filter(entry => isSpecific(entry.info)).slice(0, 3);
  const topics = specific.length ? specific : found.slice(0, 1);
  const chosen = new Set(topics.map(entry => entry.word));
  const [first, ...rest] = topics;
  return {
    term: first.word,
    label: first.info.label,
    source: "features",
    confidence: 1,
    also: rest.map(entry => ({ term: entry.word, label: entry.info.label })),
    traits: candidates.filter(word => !chosen.has(word)),
  };
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
