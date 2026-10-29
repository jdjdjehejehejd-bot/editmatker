import { useEffect, useMemo, useRef, useState } from "react";
import { runPipeline, type LoadedSource, type PipelineResult, type StepId } from "./lib/pipeline";
import { ASPECT_SIZE, renderEdit, type Aspect } from "./lib/render";
import { canShareFile, isMobile, keepScreenOn, LIMITS, unlockAudio } from "./lib/device";
import { detectHelper, rememberedHelper, type HelperStatus } from "./lib/social";
import type { LicenseMode, SourceVideo } from "./lib/sources";
import { EFFECT_LABEL, GRADE_LABEL, parseStyle } from "./lib/style";

const STEPS: { id: StepId; label: string }[] = [
  { id: "topic", label: "주제 해석" },
  { id: "search", label: "관련 영상 검색" },
  { id: "download", label: "영상 가져오기" },
  { id: "analyze", label: "하이라이트 분석" },
  { id: "plan", label: "비트 편집 구성" },
  { id: "render", label: "렌더링" },
];

const EXAMPLES = [
  { topic: "아폴로 11호", features: "웅장하고 시네마틱하게, 로켓 발사, 슬로우모션" },
  { topic: "고양이", features: "귀엽고 신나는 빠른 컷, 비트에 맞춰 줌, 선명한 색" },
  { topic: "Tokyo", features: "레트로 신스웨이브, 야경, 글리치, 네온" },
  { topic: "바다", features: "잔잔한 감성, 파도, 따뜻한 색감, 필름 그레인" },
];

const SOURCE_COLORS = ["#f26a4b", "#4bb3f2", "#7bd389", "#f2c94b", "#b57bf2", "#f27bb5"];

type Status = "idle" | "running" | "done" | "error";

export default function App() {
  const [topic, setTopic] = useState("");
  const [features, setFeatures] = useState("");
  const [seconds, setSeconds] = useState(30);
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [sourceCount, setSourceCount] = useState(LIMITS.defaultSources);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [licenseMode, setLicenseMode] = useState<LicenseMode>("any");

  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<{ id: StepId; detail: string; ratio?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SourceVideo[]>([]);
  const [loaded, setLoaded] = useState<LoadedSource[]>([]);
  const [skipped, setSkipped] = useState<{ title: string; reason: string }[]>([]);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [output, setOutput] = useState<{ url: string; ext: string; file: File } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const preview = useMemo(() => parseStyle(features), [features]);
  const [width, height] = ASPECT_SIZE[aspect];

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
    setLoaded([]);
    setSkipped([]);
    setResult(null);
    setOutput(null);
    setError(null);
  };

  const start = async () => {
    if (!topic.trim() || status === "running") return;
    reset();
    const controller = new AbortController();
    abortRef.current = controller;
    // 버튼을 누른 이 순간에 오디오를 깨워야 iOS에서 음악이 녹음됩니다.
    const audio = unlockAudio();
    const releaseScreen = await keepScreenOn();
    setStatus("running");
    stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      // 도우미를 페이지를 연 뒤에 켰을 수도 있으니 시작할 때 다시 확인합니다.
      const currentHelper = !isMobile && rememberedHelper() ? await connectHelper() : helper;
      const pipeline = await runPipeline(
        { topic: topic.trim(), features, seconds, sourceCount, musicFile, licenseMode, helper: currentHelper.ytDlp ? currentHelper.base : null },
        {
          step: (id, detail, ratio) => setStep({ id, detail, ratio }),
          candidates: setCandidates,
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
        title: pipeline.topic.label,
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

  const downloadPlan = () => {
    if (!result) return;
    const json = {
      topic: result.topic,
      style: { ...result.style, effects: [...result.style.effects] },
      plan: result.plan,
      sources: result.sources.map(({ analysis, scores, url, ...rest }) => rest),
      credits: result.credits,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(topic)}-edit-plan.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stepIndex = step ? STEPS.findIndex(s => s.id === step.id) : -1;
  const colorOf = (id: string) => SOURCE_COLORS[Math.max(0, loaded.findIndex(s => s.id === id)) % SOURCE_COLORS.length];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="./favicon.svg" alt="" width={28} height={28} />
          <span>editmatker</span>
        </div>
        <span className="tagline">주제와 특징만 적으면, 하이라이트를 찾아 비트에 맞춰 편집합니다</span>
      </header>

      <main className="layout">
        <section className="panel form">
          <h1>
            무엇으로 <em>에딧</em>을 만들까요?
          </h1>

          <label className="field">
            <span>주제</span>
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="예: 아폴로 11호, 고양이, 서울, Formula 1" maxLength={80} onKeyDown={e => e.key === "Enter" && start()} />
          </label>

          <label className="field">
            <span>특징 · 분위기</span>
            <textarea value={features} onChange={e => setFeatures(e.target.value)} rows={3} maxLength={300} placeholder="예: 웅장하고 시네마틱하게, 슬로우모션, 따뜻한 색감, 플래시 컷" />
          </label>

          <div className="examples">
            {EXAMPLES.map(example => (
              <button
                key={example.topic}
                type="button"
                className="chip"
                onClick={() => {
                  setTopic(example.topic);
                  setFeatures(example.features);
                }}
              >
                {example.topic}
              </button>
            ))}
          </div>

          <div className="style-preview" aria-live="polite">
            <strong>{preview.label}</strong>
            <span>{musicFile ? "음악 BPM 자동 감지" : `${preview.bpm} BPM`}</span>
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
              <span>사용할 영상 수 · {sourceCount}개</span>
              <input type="range" min={2} max={LIMITS.maxSources} value={sourceCount} onChange={e => setSourceCount(Number(e.target.value))} />
            </label>
            <label className="field">
              <span>배경음악</span>
              <div className="file">
                <input type="file" accept="audio/*" onChange={e => setMusicFile(e.target.files?.[0] ?? null)} />
                <small>{musicFile ? musicFile.name : "비워 두면 분위기에 맞는 비트를 자동 작곡"}</small>
              </div>
            </label>
          </div>

          <div className="field">
            <span>영상 라이선스</span>
            <Segmented
              options={["any", "reusable"] as LicenseMode[]}
              value={licenseMode}
              onChange={setLicenseMode}
              format={mode => (mode === "any" ? "모든 공개 영상" : "재사용 가능만")}
            />
            <small className="hint">
              {licenseMode === "any"
                ? `${isMobile ? "Reddit" : "YouTube·Reddit"} 위주로 라이선스와 관계없이 찾습니다. 결과물을 공개적으로 올리려면 원작자 허락이 필요할 수 있어요.`
                : "Wikimedia Commons·Internet Archive의 Public domain · CC0 · CC BY · CC BY-SA 영상만 써서 결과물을 자유롭게 공유할 수 있어요."}
            </small>
          </div>

          {licenseMode === "any" && isMobile && !helper.ytDlp && (
            <div className="helper">
              <b>📱 휴대폰 모드</b> Reddit·Wikimedia Commons·Internet Archive에서 영상을 찾아요. YouTube 영상은 PC에서 로컬 도우미를 켰을 때만 쓸 수 있어요.
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
                  <b>○ YouTube 꺼짐</b> 지금은 Reddit 영상만 찾아요. YouTube까지 쓰려면 내 컴퓨터에서 로컬 도우미(<code>pnpm helper</code>)를 켠 뒤 연결하세요.{" "}
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

          {status === "running" ? (
            <button className="primary" type="button" onClick={stop}>
              중단하기
            </button>
          ) : (
            <button className="primary" type="button" onClick={start} disabled={!topic.trim()}>
              {status === "done" ? "다시 만들기" : "에딧 만들기"}
            </button>
          )}

          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className={i < stepIndex || status === "done" ? "done" : i === stepIndex && status === "running" ? "active" : i === stepIndex && status === "error" ? "failed" : ""}>
                <span className="dot" />
                <div>
                  <strong>{s.label}</strong>
                  {i === stepIndex && status !== "done" && step && <small>{step.detail}</small>}
                  {i === stepIndex && status === "running" && step?.ratio !== undefined && (
                    <div className="bar">
                      <i style={{ width: `${Math.round(step.ratio * 100)}%` }} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel stage" ref={stageRef}>
          <div className="screen" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, calc(72vh * ${width / height}))` }}>
            <canvas ref={canvasRef} width={width} height={height} hidden={Boolean(output)} />
            {output && <video src={output.url} controls autoPlay loop playsInline />}
            {status === "idle" && !output && (
              <div className="placeholder">
                <b>▶</b>
                <p>주제를 입력하고 에딧 만들기를 누르면 여기서 편집 과정이 재생돼요.</p>
              </div>
            )}
          </div>
          {output && (
            <div className="actions">
              {canShareFile(output.file) ? (
                <button type="button" className="primary" onClick={share}>
                  공유 · 사진에 저장
                </button>
              ) : (
                <a className="primary" href={output.url} download={output.file.name}>
                  영상 저장 (.{output.ext})
                </a>
              )}
              <button type="button" className="ghost" onClick={downloadPlan}>
                편집 계획 JSON
              </button>
            </div>
          )}

          {result && (
            <div className="timeline" aria-label="타임라인">
              {result.plan.segments.map((seg, i) => (
                <i
                  key={i}
                  title={`${seg.section} · ${seg.duration.toFixed(2)}초${seg.rate < 1 ? " · 슬로모션" : ""}`}
                  style={{ flexGrow: seg.duration, background: colorOf(seg.sourceId), opacity: seg.section === "drop" ? 1 : 0.55 }}
                />
              ))}
            </div>
          )}
          {result && (
            <p className="meta">
              {result.plan.segments.length}컷 · {result.plan.bpm} BPM · 드롭 {result.plan.dropAt.toFixed(1)}초 · {GRADE_LABEL[result.style.grade]}
            </p>
          )}
        </section>
      </main>

      {(loaded.length > 0 || candidates.length > 0) && (
        <section className="sources">
          <h2>
            사용한 영상 <small>{candidates.length}개 후보 중 {loaded.length}개 · 그래프는 장면 점수, 칠해진 구간이 뽑힌 하이라이트</small>
          </h2>
          <div className="grid">
            {loaded.map(source => (
              <article key={source.id} className="card">
                {source.poster ? <img src={source.poster} alt="" loading="lazy" onError={e => (e.currentTarget.style.visibility = "hidden")} /> : <div className="poster" />}
                <div className="card-body">
                  <a href={source.pageUrl} target="_blank" rel="noreferrer" className="title">
                    <i style={{ background: colorOf(source.id) }} />
                    {source.title}
                  </a>
                  <small>
                    {source.author} ·{" "}
                    {source.licenseUrl ? (
                      <a href={source.licenseUrl} target="_blank" rel="noreferrer">
                        {source.license}
                      </a>
                    ) : (
                      source.license
                    )}{" "}
                    · {source.provider}
                    {!source.reusable && <em className="badge">재사용 허가 확인 필요</em>}
                  </small>
                  <ScoreGraph source={source} color={colorOf(source.id)} />
                </div>
              </article>
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
          영상은 YouTube·Reddit(모든 공개 영상 모드)과 Wikimedia Commons·Internet Archive에서 가져오며, 영상 끝에 출처 크레딧이 자동으로 들어갑니다. <b>모든 공개 영상</b>을 고르면 비영리(NC)·변경금지(ND)이거나 라이선스가 표시되지 않은 영상도 쓰므로, 결과물을 공개적으로 올리기 전에 원작자 허락이 필요한지 확인하세요. 결과물을 자유롭게 공유하려면 <b>재사용 가능만</b>(Public domain · CC0 · CC BY · CC BY-SA)을 고르세요. CC BY-SA 자료가 포함되면 결과물도 같은 조건으로 공유해야 합니다.
        </p>
        <p>모든 처리는 브라우저 안에서 이루어지며 영상이 서버로 업로드되지 않습니다. 최신 Chrome · Edge · Firefox 데스크톱을 권장합니다.</p>
      </footer>
    </div>
  );
}

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

function ScoreGraph({ source, color }: { source: LoadedSource; color: string }) {
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
}

function slug(text: string) {
  return text.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "edit";
}
