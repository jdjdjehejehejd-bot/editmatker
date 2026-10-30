import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { runPipeline, type LoadedSource, type PipelineResult, type QueryGroup, type StepId } from "./lib/pipeline";
import { ASPECT_SIZE, renderEdit, type Aspect } from "./lib/render";
import { canShareFile, isMobile, keepScreenOn, LIMITS, unlockAudio } from "./lib/device";
import { detectHelper, rememberedHelper, type HelperStatus } from "./lib/social";
import { checkUserInput, isNsfwRequested, isTextAllowed } from "./lib/moderation";
import { BUILTIN_PRESETS, loadPresets, matchesPreset, savePresets, upsertPreset, type Preset, type PresetSettings } from "./lib/presets";
import { parseTopicInput, type TopicSpec } from "./lib/topic";
import { describeProfile } from "./lib/learn";
import type { LicenseMode, SourceVideo } from "./lib/sources";
import { EFFECT_LABEL, GRADE_LABEL, parseStyle, type EditStyle } from "./lib/style";

const STEPS: { id: StepId; label: string }[] = [
  { id: "topic", label: "주제 해석" },
  { id: "search", label: "관련 영상 검색" },
  { id: "learn", label: "참고 에딧 학습" },
  { id: "download", label: "영상 가져오기" },
  { id: "analyze", label: "하이라이트 분석" },
  { id: "plan", label: "비트 편집 구성" },
  { id: "render", label: "렌더링" },
];


const SOURCE_COLORS = ["#f26a4b", "#4bb3f2", "#7bd389", "#f2c94b", "#b57bf2", "#f27bb5"];

type Status = "idle" | "running" | "done" | "error";

/** 만들기를 누른 순간의 입력 — 만드는 도중에 입력을 바꿔도 게시물 설명·화면 비율은 이 값을 따릅니다. */
interface RunSnapshot {
  specs: TopicSpec[];
  style: EditStyle;
  aspect: Aspect;
  hasMusic: boolean;
}

export default function App() {
  const [topic, setTopic] = useState("");
  const [features, setFeatures] = useState("");
  const [seconds, setSeconds] = useState(30);
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [sourceCount, setSourceCount] = useState(LIMITS.defaultSources);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [learnOnline, setLearnOnline] = useState(false);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [licenseMode, setLicenseMode] = useState<LicenseMode>("any");
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [run, setRun] = useState<RunSnapshot | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [step, setStepNow] = useState<{ id: StepId; detail: string; ratio?: number } | null>(null);
  // 속도: 진행률은 초당 수십 번 바뀌므로 화면 갱신을 0.1초에 한 번으로 묶습니다(단계가 바뀌면 바로 반영).
  const pendingStep = useRef<{ id: StepId; detail: string; ratio?: number } | null>(null);
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownStepId = useRef<StepId | null>(null);
  const setStep = useCallback((next: { id: StepId; detail: string; ratio?: number } | null) => {
    pendingStep.current = next;
    const flush = () => {
      stepTimer.current = null;
      shownStepId.current = pendingStep.current?.id ?? null;
      setStepNow(pendingStep.current);
    };
    if (!next || next.id !== shownStepId.current) {
      if (stepTimer.current) clearTimeout(stepTimer.current);
      flush();
    } else if (!stepTimer.current) {
      stepTimer.current = setTimeout(flush, 100);
    }
  }, []);
  useEffect(() => () => void (stepTimer.current && clearTimeout(stepTimer.current)), []);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SourceVideo[]>([]);
  const [queries, setQueries] = useState<QueryGroup[]>([]);
  const [loaded, setLoaded] = useState<LoadedSource[]>([]);
  const [skipped, setSkipped] = useState<{ title: string; reason: string }[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [output, setOutput] = useState<{ url: string; ext: string; file: File } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const sourcesRef = useRef<HTMLElement>(null);
  const [liked, setLiked] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const preview = useMemo(() => parseStyle(features), [features]);
  const topicSpecs = useMemo(() => parseTopicInput(topic), [topic]);
  const blockedInput = useMemo(() => checkUserInput(topic, features), [topic, features]);
  const nsfwMode = useMemo(() => isNsfwRequested(features), [features]);
  const topicWeightSum = topicSpecs.reduce((sum, spec) => sum + spec.weight, 0) || 1;
  const currentSettings: PresetSettings = { topic, features, seconds, aspect, sourceCount, licenseMode };
  // 만들기를 시작한 뒤로는 그때의 입력(run)을 보여 주고, 아직 만든 적이 없으면 지금 입력을 미리 보여 줍니다.
  const shown: RunSnapshot = status === "idle" && !run ? { specs: topicSpecs, style: preview, aspect, hasMusic: Boolean(musicFile) } : run!;
  const [width, height] = ASPECT_SIZE[shown.aspect];

  const savePreset = () => {
    if (!topic.trim()) return;
    const suggested = topicSpecs.map(spec => spec.term).join(" · ").slice(0, 24);
    const name = typeof window.prompt === "function" ? window.prompt("프리셋 이름", suggested) : suggested;
    if (!name?.trim()) return;
    setPresets(list => {
      const next = upsertPreset(list, name, currentSettings);
      savePresets(next);
      return next;
    });
  };
  const removePreset = (id: string) =>
    setPresets(list => {
      const next = list.filter(p => p.id !== id);
      savePresets(next);
      return next;
    });
  const applyPreset = (preset: Preset) => {
    setTopic(preset.topic);
    setFeatures(preset.features);
    setSeconds(preset.seconds);
    setAspect(preset.aspect);
    setSourceCount(Math.min(preset.sourceCount, LIMITS.maxSources));
    setLicenseMode(preset.licenseMode);
  };

  const [helper, setHelper] = useState<HelperStatus>({ base: null, ytDlp: null });
  const [checkingHelper, setCheckingHelper] = useState(false);
  const [helperMissing, setHelperMissing] = useState(false);

  const connectHelper = async () => {
    setCheckingHelper(true);
    const status = await detectHelper();
    setHelper(status);
    setHelperMissing(!status.base);
    setCheckingHelper(false);
    return status;
  };

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (rememberedHelper()) void connectHelper();
  }, []);

  const reset = () => {
    loaded.forEach(s => URL.revokeObjectURL(s.url));
    if (output) URL.revokeObjectURL(output.url);
    setCandidates([]);
    setQueries([]);
    setLoaded([]);
    setSkipped([]);
    setResult(null);
    setOutput(null);
    setError(null);
  };

  const start = async () => {
    if (!topic.trim() || status === "running" || blockedInput) return;
    reset();
    const controller = new AbortController();
    abortRef.current = controller;
    // 버튼을 누른 이 순간에 오디오를 깨워야 iOS에서 음악이 녹음됩니다.
    const audio = unlockAudio();
    const releaseScreen = await keepScreenOn();
    setRun({ specs: topicSpecs, style: preview, aspect, hasMusic: Boolean(musicFile) });
    setStatus("running");
    stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      // 도우미를 페이지를 연 뒤에 켰을 수도 있으니 시작할 때 다시 확인합니다.
      const currentHelper = !isMobile && rememberedHelper() ? await connectHelper() : helper;
      const pipeline = await runPipeline(
        { topic: topic.trim(), features, seconds, sourceCount, musicFile, licenseMode, learnOnline, referenceFiles, helper: currentHelper.ytDlp ? currentHelper.base : null },
        {
          step: (id, detail, ratio) => setStep({ id, detail, ratio }),
          candidates: setCandidates,
          queries: setQueries,
          loaded: source => setLoaded(list => [...list, source]),
          skipped: (source, reason) => setSkipped(list => [...list, { title: source.title, reason }]),
        },
        controller.signal
      );
      setResult(pipeline);
      setStep({ id: "render", detail: "실시간으로 렌더링하는 중 — 탭을 닫거나 숨기지 마세요", ratio: 0 });
      const rendered = await renderEdit({
        canvas: canvasRef.current!,
        plan: pipeline.plan,
        style: pipeline.style,
        sources: pipeline.sources,
        title: pipeline.title,
        subtitle: pipeline.style.label,
        credits: pipeline.credits,
        music: pipeline.music,
        audio,
        signal: controller.signal,
        onProgress: ratio => setStep({ id: "render", detail: "실시간으로 렌더링하는 중 — 탭을 닫거나 숨기지 마세요", ratio }),
      });
      const ext = rendered.mimeType.includes("mp4") ? "mp4" : "webm";
      const file = new File([rendered.blob], `${slug(topic)}-edit.${ext}`, { type: rendered.blob.type });
      setOutput({ url: URL.createObjectURL(rendered.blob), ext, file });
      setStatus("done");
    } catch (e) {
      void audio.close().catch(() => undefined);
      if (controller.signal.aborted) {
        setStatus("idle");
        setStep(null);
        return;
      }
      setError(e instanceof Error ? e.message : "알 수 없는 오류가 발생했어요.");
      setStatus("error");
    } finally {
      releaseScreen();
    }
  };

  const share = async () => {
    if (!output) return;
    try {
      await navigator.share({ files: [output.file], title: `${topic} edit` });
    } catch {
      /* 사용자가 공유를 취소함 */
    }
  };

  const stop = () => abortRef.current?.abort();

  const downloadVideo = () => {
    if (!output) return;
    const a = document.createElement("a");
    a.href = output.url;
    a.download = output.file.name;
    a.click();
  };

  const downloadPlan = () => {
    if (!result) return;
    const json = {
      topics: result.topics.map(({ info, weight, queries }) => ({ ...info, weight, queries })),
      style: { ...result.style, effects: [...result.style.effects] },
      plan: result.plan,
      sources: result.sources.map(({ analysis, scores, url, ...rest }) => rest),
      credits: result.credits,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(result.title)}-edit-plan.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stepIndex = step ? STEPS.findIndex(s => s.id === step.id) : -1;
  const colorOf = (id: string) => SOURCE_COLORS[Math.max(0, loaded.findIndex(s => s.id === id)) % SOURCE_COLORS.length];
  const isBlockedError = Boolean(error?.startsWith("생성 불가"));
  const reelTitle = result?.title ?? (shown.specs.map(spec => spec.term).join(" × ") || "editmatker");
  // 다 만들었으면 실제로 쓴 스타일(참고 에딧에서 배운 값 포함), 아니면 만들기를 누른 순간의 스타일
  const captionStyle = result?.style ?? shown.style;
  const hashtags = [captionStyle.label.split("·")[0], GRADE_LABEL[captionStyle.grade], ...[...captionStyle.effects].slice(0, 3).map(effect => EFFECT_LABEL[effect])]
    .map(tag => `#${tag.replace(/\s+/g, "")}`)
    .join(" ");
  const barState = (i: number) => (status === "done" || i < stepIndex ? "done" : i === stepIndex && status === "running" ? "active" : i === stepIndex && status === "error" ? "failed" : "");
  const statusText =
    status === "running" && step ? `${STEPS[stepIndex]?.label ?? ""} · ${step.detail}` : status === "done" ? "완성! 아래에서 저장하거나 공유하세요." : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="wordmark">
            <img src="./favicon.svg" alt="" width={26} height={26} />
            <span>editmatker</span>
          </div>
          {nsfwMode ? (
            <span className="shield off" title="성적 콘텐츠 검열이 꺼져 있어요">
              <ShieldIcon /> 검열 해제
            </span>
          ) : (
            <span className="shield" title="부적절한 단어·장면이 있는 영상은 쓰지 않아요">
              <ShieldIcon /> 검열 켜짐
            </span>
          )}
        </div>
      </header>

      <main className="feed">
        <section className="stories" aria-label="프리셋">
          <button type="button" className="story add" onClick={savePreset} disabled={!topic.trim()} title="지금 입력을 프리셋으로 저장">
            <span className="ring">
              <span className="avatar">+</span>
            </span>
            <small>프리셋 저장</small>
          </button>
          {[...presets, ...BUILTIN_PRESETS].map(preset => {
            const active = matchesPreset(preset, currentSettings);
            return (
              <div key={preset.id} className={`story preset ${active ? "active" : ""}`}>
                <button type="button" className="story-hit" onClick={() => applyPreset(preset)} title={`${preset.topic} · ${preset.features || "특징 없음"}`}>
                  <span className="ring">
                    <span className="avatar">{preset.name.slice(0, 1).toUpperCase()}</span>
                  </span>
                  <small>{preset.name}</small>
                </button>
                {!preset.builtin && (
                  <button type="button" className="story-remove" aria-label={`${preset.name} 프리셋 지우기`} onClick={() => removePreset(preset.id)}>
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </section>

        <div className="columns">
          <section className="card compose">
            <div className="card-head">
              <span className="mini-ring">
                <img src="./favicon.svg" alt="" />
              </span>
              <div>
                <strong>새 에딧 만들기</strong>
                <small>인물·주제를 입력하면 그 대상이 나오는 영상만 골라 편집해요</small>
              </div>
            </div>

            <label className="field">
              <span>주제</span>
              <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="예: 손흥민, 3:케인:, 토트넘" maxLength={200} onKeyDown={e => e.key === "Enter" && start()} />
              <small className="hint">
                쉼표로 여러 주제를 섞을 수 있어요 · <code>3:케인:</code>은 3배 비중
              </small>
            </label>
            {topicSpecs.length > 1 || topicSpecs.some(spec => spec.weight !== 1) ? (
              <div className="topic-chips" aria-label="주제 비중">
                {topicSpecs.map(spec => (
                  <span key={spec.term} className={isTextAllowed(spec.term) ? "" : "blocked"}>
                    {spec.term}
                    <b>{Math.round((spec.weight / topicWeightSum) * 100)}%</b>
                  </span>
                ))}
              </div>
            ) : null}

            <label className="field">
              <span>특징 · 분위기</span>
              <textarea value={features} onChange={e => setFeatures(e.target.value)} rows={2} maxLength={300} placeholder="예: 웅장하고 시네마틱하게, 슬로우모션, 따뜻한 색감" />
            </label>

            <div className="style-preview" aria-live="polite">
              <strong>{preview.label}</strong>
              <span>{musicFile ? "BPM 자동" : `${preview.bpm} BPM`}</span>
              <span>{GRADE_LABEL[preview.grade]}</span>
              {[...preview.effects].map(effect => (
                <span key={effect}>{EFFECT_LABEL[effect]}</span>
              ))}
            </div>

            <div className="row">
              <div className="field">
                <span>길이</span>
                <Segmented options={[15, 30, 45, 60]} value={seconds} onChange={setSeconds} format={v => `${v}초`} />
              </div>
              <div className="field">
                <span>화면 비율</span>
                <Segmented options={["9:16", "16:9", "1:1"] as Aspect[]} value={aspect} onChange={setAspect} />
              </div>
            </div>

            <div className="row">
              <label className="field">
                <span>영상 수 · {sourceCount}개</span>
                <input type="range" min={2} max={LIMITS.maxSources} value={sourceCount} onChange={e => setSourceCount(Number(e.target.value))} style={{ "--fill": `${((sourceCount - 2) / (LIMITS.maxSources - 2)) * 100}%` } as CSSProperties} />
              </label>
              <label className="field">
                <span>배경음악</span>
                <div className="file">
                  <input type="file" accept="audio/*" onChange={e => setMusicFile(e.target.files?.[0] ?? null)} />
                  <small>{musicFile ? musicFile.name : "비워 두면 자동 작곡"}</small>
                </div>
              </label>
            </div>

            <div className="field">
              <span>참고 에딧 · 스타일 배우기</span>
              <div className="learn">
                <label className="toggle">
                  <input type="checkbox" checked={learnOnline} onChange={e => setLearnOnline(e.target.checked)} />
                  <span>인터넷에서 "주제 edit" 찾아 배우기</span>
                </label>
                <label className="file">
                  <input type="file" accept="video/*" multiple onChange={e => setReferenceFiles([...(e.target.files ?? [])].slice(0, 3))} />
                  <small>{referenceFiles.length ? referenceFiles.map(f => f.name).join(", ") : "마음에 드는 에딧 영상을 올리면 컷 리듬·템포·색감을 따라 해요 (최대 3개)"}</small>
                </label>
              </div>
            </div>

            <div className="field">
              <span>영상 라이선스</span>
              <Segmented options={["any", "reusable"] as LicenseMode[]} value={licenseMode} onChange={setLicenseMode} format={mode => (mode === "any" ? "모든 공개 영상" : "재사용 가능만")} />
              <small className="hint">
                {licenseMode === "any"
                  ? `${isMobile ? "Reddit" : "YouTube·Reddit"} 위주로 찾아요. 공개적으로 올리려면 원작자 허락이 필요할 수 있어요.`
                  : "Public domain · CC0 · CC BY · CC BY-SA 영상만 써서 자유롭게 공유할 수 있어요."}
              </small>
            </div>

            {licenseMode === "any" && isMobile && !helper.ytDlp && (
              <div className="helper">
                <b>휴대폰 모드</b> Reddit·Wikimedia Commons·Internet Archive에서 찾아요. YouTube는 PC에서 로컬 도우미를 켰을 때만 쓸 수 있어요.
              </div>
            )}

            {licenseMode === "any" && !isMobile && (
              <div className={`helper ${helper.ytDlp ? "on" : ""}`}>
                {helper.ytDlp ? (
                  <>
                    <b>● YouTube 연결됨</b> 로컬 도우미(yt-dlp {helper.ytDlp})로 YouTube·Reddit 영상을 받아요.
                  </>
                ) : helper.base ? (
                  <>
                    <b>● 도우미에 yt-dlp가 없어요</b> yt-dlp를 설치한 뒤 도우미를 다시 켜 주세요.
                  </>
                ) : (
                  <>
                    <b>YouTube 꺼짐</b> 내 컴퓨터에서 로컬 도우미(<code>pnpm helper</code>)를 켜면 YouTube 영상도 써요.{" "}
                    <a href="https://github.com/jdjdjehejehejd-bot/editmatker#youtube-로컬-도우미-pc-전용" target="_blank" rel="noreferrer">
                      방법 보기
                    </a>
                    <button type="button" className="chip connect" onClick={connectHelper} disabled={checkingHelper}>
                      {checkingHelper ? "확인 중…" : "YouTube 연결"}
                    </button>
                    {helperMissing && <em className="missing">도우미를 찾지 못했어요. 터미널에서 실행 중인지 확인하세요.</em>}
                  </>
                )}
              </div>
            )}

            {blockedInput && <p className="error blocked">🚫 {blockedInput}</p>}

            {status === "running" ? (
              <button className="primary" type="button" onClick={stop}>
                중단하기
              </button>
            ) : (
              <button className="primary" type="button" onClick={start} disabled={!topic.trim() || Boolean(blockedInput)}>
                {blockedInput ? "생성 불가" : status === "done" ? "다시 만들기" : "에딧 만들기"}
              </button>
            )}
          </section>

          <article className="card reel" ref={stageRef}>
            <header className="reel-head">
              <span className={`mini-ring ${status === "running" ? "spin" : ""}`}>
                <img src="./favicon.svg" alt="" />
              </span>
              <div>
                <strong>{reelTitle}</strong>
                <small>{result ? `${result.plan.segments.length}컷 · ${result.plan.bpm} BPM · ${GRADE_LABEL[result.style.grade]}` : `${shown.style.label} · ${shown.hasMusic ? "내 음악" : "자동 작곡 음악"}`}</small>
              </div>
              <span className="more" aria-hidden>
                <MoreIcon />
              </span>
            </header>

            <div className="reel-media">
              <div className="screen" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, calc(70vh * ${width / height}))` }}>
                <div className="story-bars" aria-label="진행 단계">
                  {STEPS.map((s, i) => (
                    <i key={s.id} className={barState(i)} title={s.label}>
                      <b style={i === stepIndex && status === "running" && step?.ratio !== undefined ? { width: `${Math.round(step.ratio * 100)}%` } : undefined} />
                    </i>
                  ))}
                </div>
                <canvas ref={canvasRef} width={width} height={height} hidden={Boolean(output)} />
                {output && <video src={output.url} controls autoPlay loop playsInline />}
                {status === "idle" && !output && (
                  <div className="placeholder">
                    <b>
                      <PlayIcon />
                    </b>
                    <p>주제를 입력하고 에딧 만들기를 누르면 여기서 편집 과정이 재생돼요</p>
                  </div>
                )}
                {statusText && status === "running" && <div className="reel-status">{statusText}</div>}
              </div>
            </div>

            <div className="reel-actions">
              <button type="button" className={`icon ${liked ? "liked" : ""}`} aria-label="좋아요" onClick={() => setLiked(v => !v)}>
                <HeartIcon filled={liked} />
              </button>
              <button type="button" className="icon" aria-label="사용한 영상 보기" onClick={() => sourcesRef.current?.scrollIntoView({ behavior: "smooth" })} disabled={!loaded.length}>
                <CommentIcon />
              </button>
              <button type="button" className="icon" aria-label="공유·저장" onClick={output ? (canShareFile(output.file) ? share : () => downloadVideo()) : undefined} disabled={!output}>
                <SendIcon />
              </button>
              <span className="spacer" />
              <button type="button" className="icon" aria-label="편집 계획 저장" onClick={downloadPlan} disabled={!result}>
                <BookmarkIcon />
              </button>
            </div>

            <div className="reel-body">
              {result && (
                <div className="timeline" aria-label="타임라인">
                  {result.plan.segments.map((seg, i) => (
                    <i
                      key={i}
                      title={`${seg.section} · ${seg.duration.toFixed(2)}초${seg.rate < 1 ? " · 슬로모션" : ""}`}
                      style={{ flexGrow: seg.duration, background: colorOf(seg.sourceId), opacity: seg.section === "drop" ? 1 : 0.5 }}
                    />
                  ))}
                </div>
              )}
              <p className="caption">
                <strong>editmatker</strong> {reelTitle} 에딧 <span className="tags">{hashtags}</span>
              </p>
              {statusText && status !== "running" && <p className="status-line">{statusText}</p>}
              {result && result.topicSummary.length > 1 && (
                <div className={`topic-summary ${result.topicSummary.some(t => !t.used) ? "warn" : ""}`}>
                  <b>주제별 영상</b>
                  {result.topicSummary.map(t => (
                    <span key={t.label} title={t.note ?? undefined}>
                      {t.label} {t.used}개{t.note ? ` — ${t.note}` : ""}
                    </span>
                  ))}
                </div>
              )}
              {result?.profile && (
                <p className="learned">
                  <b>배운 스타일</b> {describeProfile(result.profile)} · 컷 {result.profile.cuts}개 분석{result.profile.grade ? ` · ${GRADE_LABEL[result.profile.grade]}` : ""}
                </p>
              )}
              {queries.length > 0 && (
                <div className="queries">
                  {queries.map(group => (
                    <div key={group.label}>
                      <span>{queries.length > 1 ? `${group.label}${group.weight !== 1 ? ` ×${group.weight}` : ""}` : "검색어"}</span>
                      {group.queries.map(q => (
                        <em key={q}>{q}</em>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {error && <p className={`error ${isBlockedError ? "blocked" : ""}`}>{isBlockedError ? `🚫 ${error}` : error}</p>}
              {output && (
                <div className="actions">
                  {canShareFile(output.file) ? (
                    <button type="button" className="primary" onClick={share}>
                      공유 · 사진에 저장
                    </button>
                  ) : (
                    <button type="button" className="primary" onClick={downloadVideo}>
                      영상 저장 (.{output.ext})
                    </button>
                  )}
                </div>
              )}
            </div>
          </article>
        </div>

        {(loaded.length > 0 || candidates.length > 0) && (
          <section className="sources" ref={sourcesRef}>
            <div className="sources-head">
              <strong>사용한 영상</strong>
              <small>
                후보 {candidates.length}개 중 {loaded.length}개 · 그래프는 장면 점수, 칠해진 구간이 뽑힌 하이라이트
              </small>
            </div>
            <div className="grid">
              {loaded.map(source => (
                <a key={source.id} className="tile" href={source.pageUrl} target="_blank" rel="noreferrer" title={source.title}>
                  {source.poster ? <img src={source.poster} alt="" loading="lazy" onError={e => (e.currentTarget.style.visibility = "hidden")} /> : <span className="poster" />}
                  <span className="tile-badge">{source.provider}</span>
                  <span className="tile-info">
                    <b>
                      <i style={{ background: colorOf(source.id) }} />
                      {source.title}
                    </b>
                    <small>
                      {loaded.some(other => other.topicLabel !== source.topicLabel) && <em className="topic-tag">{source.topicLabel} · </em>}
                      {source.author} · {source.license}
                      {!source.reusable && " · 재사용 허가 확인 필요"}
                    </small>
                    <ScoreGraph source={source} color={colorOf(source.id)} />
                  </span>
                </a>
              ))}
            </div>
            {skipped.length > 0 && (
              <details className="skipped">
                <summary>건너뛴 영상 {skipped.length}개</summary>
                <ul>
                  {skipped.map((s, i) => (
                    <li key={i}>
                      {s.title} — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        <footer className="notes">
          <p>
            영상은 YouTube·Reddit(모든 공개 영상 모드)과 Wikimedia Commons·Internet Archive에서 가져오며, 제목·설명에 주제 이름이 나오는 영상만 씁니다. 영상 끝에 출처 크레딧이 자동으로 들어갑니다. <b>모든 공개 영상</b>은 재사용 허가가 없는 영상도 쓰므로 공개적으로 올리기 전에 원작자 허락이 필요한지 확인하세요. 자유롭게 공유하려면 <b>재사용 가능만</b>을 고르세요.
          </p>
          <p>검열: 입력·검색어·영상 제목·채널·분류에서 부적절한 단어를 걸러내고, 영상마다 장면 10개를 기기 안의 NSFW.js 모델로 검사합니다. 자동 검사라 완벽하지 않을 수 있어요.</p>
          <p>모든 처리는 브라우저 안에서 이루어지며 영상이 서버로 업로드되지 않습니다.</p>
        </footer>
      </main>
    </div>
  );
}

function Icon({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const HeartIcon = ({ filled }: { filled?: boolean }) => (
  <Icon>
    <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.6 3.3 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" fill={filled ? "currentColor" : "none"} />
  </Icon>
);
const CommentIcon = () => (
  <Icon>
    <path d="M20.7 12a8.7 8.7 0 0 1-12.9 7.6L3.3 21l1.4-4.5A8.7 8.7 0 1 1 20.7 12z" />
  </Icon>
);
const SendIcon = () => (
  <Icon>
    <path d="M21.5 3 10.2 14.3M21.5 3l-7 18-4.3-6.7L3.5 10 21.5 3z" />
  </Icon>
);
const BookmarkIcon = () => (
  <Icon>
    <path d="M19 21l-7-5-7 5V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V21z" />
  </Icon>
);
const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </Icon>
);
const PlayIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
    <path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" />
  </svg>
);
const ShieldIcon = () => (
  <Icon size={15}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3z" />
    <path d="m8.8 12 2.2 2.2 4.2-4.4" />
  </Icon>
);

function Segmented<T extends string | number>({ options, value, onChange, format }: { options: T[]; value: T; onChange: (value: T) => void; format?: (value: T) => string }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(option => (
        <button key={String(option)} type="button" role="radio" aria-checked={option === value} className={option === value ? "on" : ""} onClick={() => onChange(option)}>
          {format ? format(option) : String(option)}
        </button>
      ))}
    </div>
  );
}

// 진행률이 바뀔 때마다 그래프를 다시 그리지 않도록 메모합니다.
const ScoreGraph = memo(function ScoreGraph({ source, color }: { source: LoadedSource; color: string }) {
  const { samples, duration } = source.analysis;
  const points = samples.map((s, i) => `${((s.t / duration) * 100).toFixed(2)},${(30 - source.scores[i] * 28).toFixed(2)}`).join(" ");
  return (
    <svg className="graph" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      {source.highlights.map((h, i) => (
        <rect key={i} x={(h.start / duration) * 100} y={0} width={(h.length / duration) * 100} height={30} fill={color} opacity={0.25} />
      ))}
      <polyline points={points} fill="none" stroke={color} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

function slug(text: string) {
  return text.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "edit";
}
