import { useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowDownToLine, ArrowUpRight, AudioLines, Check, ChevronRight,
  CircleCheck, Clapperboard, Clock3, Film, FolderOpen, Headphones, LoaderCircle,
  LockKeyhole, Music2, Play, Plus, Search, ShieldCheck, Sparkles, Trash2,
  UploadCloud, WandSparkles, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

type UploadedMedia = { id: string; name: string; kind: "video" | "audio"; durationSeconds: number };
type EditSegment = { assetId: string; startSeconds: number; durationSeconds: number; caption: string; transition: "cut" | "fade" };
type EditDraft = { title: string; summary: string; segments: EditSegment[] };
type SavedProject = { person: string; mood: string; savedAt: number; draft?: EditDraft };

const FORMAT_HINT = "MP4 · MOV · WebM / 최대 80MB";
const seconds = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

async function getMediaSession() {
  const cached = sessionStorage.getItem("editmatker.mediaSession");
  if (cached) return cached;
  const response = await fetch("/api/media/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const result = await response.json();
  if (!response.ok || typeof result.mediaSession !== "string") throw new Error(result.error || "편집 세션을 시작하지 못했어요.");
  sessionStorage.setItem("editmatker.mediaSession", result.mediaSession);
  return result.mediaSession as string;
}

function BrandMark() {
  return <div className="brand-mark" aria-hidden="true"><i /><i /><i /><b /></div>;
}

export default function Home() {
  const [person, setPerson] = useState("");
  const [mood, setMood] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [media, setMedia] = useState<UploadedMedia[]>([]);
  const [music, setMusic] = useState<UploadedMedia | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedProject[]>(() => {
    try { return JSON.parse(localStorage.getItem("editmatker.projects") || "[]"); } catch { return []; }
  });
  const [uploading, setUploading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const videoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const search = trpc.editmaker.search.useMutation();
  const createDraft = trpc.editmaker.draft.useMutation();
  const videos = search.data?.videos ?? [];
  const totalSeconds = useMemo(() => draft?.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0) ?? 0, [draft]);

  const saveProject = (next: SavedProject[]) => {
    setSaved(next);
    localStorage.setItem("editmatker.projects", JSON.stringify(next));
  };

  const runSearch = () => {
    setVideoUrl(null);
    if (!person.trim()) return;
    search.mutate({ person: person.trim(), mood: mood.trim() });
    const previous = saved.find(item => item.person === person.trim());
    const next = [{ ...previous, person: person.trim(), mood: mood.trim(), savedAt: Date.now() }, ...saved.filter(item => item.person !== person.trim())].slice(0, 5);
    saveProject(next);
  };

  const uploadFile = async (file: File, kind: "video" | "audio") => {
    if (!rightsConfirmed) return;
    setUploading(true);
    setUploadMessage("");
    try {
      const mediaSession = await getMediaSession();
      const response = await fetch("/api/media/upload", {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-Rights-Confirmed": "true", "X-Media-Session": mediaSession },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "업로드에 실패했어요.");
      const uploaded: UploadedMedia = { ...result, kind };
      if (kind === "audio") setMusic(uploaded);
      else setMedia(current => [...current, uploaded].slice(-6));
      setDraft(null);
      setVideoUrl(null);
      setUploadMessage(`${file.name} 업로드 완료`);
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : "업로드에 실패했어요.");
    } finally {
      setUploading(false);
    }
  };

  const generateDraft = () => {
    if (!rightsConfirmed || media.length === 0 || !person.trim() || mood.trim().length < 3) return;
    setDraft(null);
    setVideoUrl(null);
    void getMediaSession().then(mediaSession => createDraft.mutate({ mediaSession, person: person.trim(), mood: mood.trim(), assetIds: media.map(item => item.id), durationSeconds: 24 }, {
      onSuccess: result => {
        setDraft(result);
        saveProject([{ person: person.trim(), mood: mood.trim(), savedAt: Date.now(), draft: result }, ...saved.filter(item => item.person !== person.trim())].slice(0, 5));
      },
    })).catch(error => setUploadMessage(error instanceof Error ? error.message : "편집 세션을 시작하지 못했어요."));
  };

  const renderVideo = async () => {
    if (!draft) return;
    if (!rightsConfirmed) {
      setUploadMessage("편집을 계속하려면 소스 사용 권한 확인이 필요해요.");
      return;
    }
    if (draft.segments.some(segment => !media.some(item => item.id === segment.assetId))) {
      setUploadMessage("저장된 타임라인의 원본은 보관되지 않아요. 영상을 다시 올리고 새 타임라인을 구성해 주세요.");
      return;
    }
    setRendering(true);
    setVideoUrl(null);
    try {
      const mediaSession = await getMediaSession();
      const response = await fetch("/api/media/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaSession, segments: draft.segments, musicAssetId: music?.id }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error || "미리보기를 렌더링하지 못했어요.");
      }
      setVideoUrl(URL.createObjectURL(await response.blob()));
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : "렌더링에 실패했어요.");
    } finally {
      setRendering(false);
    }
  };

  const removeVideo = (id: string) => {
    setMedia(items => items.filter(item => item.id !== id));
    setDraft(null);
    setVideoUrl(null);
  };

  const loadProject = (project: SavedProject) => {
    setPerson(project.person);
    setMood(project.mood);
    setDraft(project.draft ?? null);
    setVideoUrl(null);
  };

  const exportTimeline = () => {
    if (!draft) return;
    const payload = { project: { person, mood, savedAt: new Date().toISOString() }, title: draft.title, summary: draft.summary, segments: draft.segments.map(segment => ({ ...segment, sourceFile: media.find(item => item.id === segment.assetId)?.name ?? "원본 재연결 필요", rightsStatus: "user-confirmed" })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "editmatker-timeline.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><BrandMark /><span>editmatker</span><small>STUDIO</small></div>
        <div className="workspace-label">WORKSPACE <button type="button" aria-label="워크스페이스 메뉴">•••</button></div>
        <button className="nav-item active"><Clapperboard size={17} /> 새 편집 <span className="nav-shortcut">⌘ N</span></button>
        <div className="side-section-title">라이브러리</div>
        <button className="nav-item" onClick={() => document.getElementById("source-library")?.scrollIntoView({ behavior: "smooth" })}><FolderOpen size={17} /> 내 소스</button>
        <button className="nav-item" onClick={() => document.getElementById("recent-projects")?.scrollIntoView({ behavior: "smooth" })}><Clock3 size={17} /> 최근 프로젝트 <span className="count-pill">{saved.length}</span></button>
        <div className="sidebar-spacer" />
        <div className="rights-card"><ShieldCheck size={17} /><div><strong>권리 먼저, 편집은 그다음</strong><p>확인된 소스만 타임라인에 들어가요.</p></div></div>
        <div className="profile-row"><div className="profile-avatar">E</div><div><strong>편집 작업실</strong><small>로컬 프로젝트</small></div><button aria-label="계정 설정">•••</button></div>
      </aside>

      <main className="main-panel">
        <header className="topbar"><div className="breadcrumbs"><span>편집 작업실</span><ChevronRight size={14} /><strong>새 편집</strong></div><div className="topbar-right"><span className="autosave"><span /> 자동 저장</span><button className="help-button" title="도움말">?</button><div className="profile-avatar small-avatar">E</div></div></header>

        <div className="workspace">
          <section className="intro-row">
            <div><div className="eyebrow"><span className="eyebrow-line" /> AI EDIT WORKSPACE</div><h1>장면을 모으고,<br /><em>이야기를 엮어요.</em></h1><p className="intro-copy">인물과 분위기를 알려주면 YouTube 최신 영상 후보를 찾고, 권리가 확인된 소스로 편집 구성을 만들어요.</p></div>
            <div className="project-stamp"><span>PROJECT NO.</span><strong>ED–001</strong><div><i /> LOCAL DRAFT</div></div>
          </section>

          <div className="work-grid">
            <section className="left-column">
              <div className="panel-card prompt-card">
                <div className="card-heading"><div className="number-badge">01</div><div><h2>누구의 어떤 순간?</h2><p>편집할 인물과 원하는 느낌을 적어주세요.</p></div><span className="required-tag">필수 입력</span></div>
                <label className="field-label" htmlFor="person">인물 이름</label>
                <div className="person-input-wrap"><Search size={17} /><input id="person" value={person} onChange={event => setPerson(event.target.value)} onKeyDown={event => { if (event.key === "Enter") runSearch(); }} placeholder="예: Zendaya, 손흥민, 김연아" maxLength={100} /><span>⌘ K</span></div>
                <label className="field-label mood-label" htmlFor="mood">원하는 분위기 <span>선택한 분위기가 컷 구성에 반영돼요</span></label>
                <textarea id="mood" value={mood} onChange={event => setMood(event.target.value)} placeholder="예: 필름 카메라 같은 따뜻한 톤. 잔잔하게 시작해 후렴에서 에너지가 터지는 느낌." maxLength={500} rows={3} />
                <div className="prompt-footer"><div className="suggestion-chips"><button onClick={() => setMood("필름 그레인, 따뜻한 색감, 느린 페이드")}>+ 필름 감성</button><button onClick={() => setMood("빠른 컷 전환, 비트에 맞춘 역동적인 분위기")}>+ 하이 에너지</button><button onClick={() => setMood("잔잔한 시작, 감정적인 순간을 담은 시네마틱 편집")}>+ 시네마틱</button></div><span>{mood.length}/500</span></div>
                <button className="search-button" onClick={runSearch} disabled={!person.trim() || search.isPending}>{search.isPending ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}<span>{search.isPending ? "최신 공개 자료 찾는 중…" : "최신 자료 찾기"}</span><ArrowUpRight size={15} /></button>
                {search.error && <div className="inline-error"><AlertCircle size={15} />{search.error.message}</div>}
              </div>

              <div className="panel-card source-card" id="source-library">
                <div className="card-heading"><div className="number-badge">02</div><div><h2>소스 라이브러리</h2><p>검색은 참고용, 편집은 권리가 확인된 파일만.</p></div><span className="source-count">{media.length} / 6 클립</span></div>
                {videos.length > 0 && <div className="search-results"><div className="result-title"><span>최신 참고 후보 · YouTube</span><small>검색 결과는 자동으로 다운로드되지 않아요</small></div>{videos.slice(0, 5).map(video => <a key={video.id} className="video-result" href={video.url} target="_blank" rel="noreferrer"><div className="video-thumb">{video.thumbnail ? <img src={video.thumbnail} alt="" /> : <Film size={18} />}<span><Play size={10} fill="currentColor" /></span></div><div className="video-meta"><strong>{video.title}</strong><small>{video.channel} · {video.published}</small></div><span className="reference-label"><LockKeyhole size={11} /> 참고용</span><ArrowUpRight size={14} /></a>)}<div className="rights-note"><ShieldCheck size={14} /> 이 목록은 참고 링크입니다. 검색 결과의 저작권 상태는 확인되지 않았어요.</div></div>}
                {search.isSuccess && videos.length === 0 && <div className="rights-note"><Search size={14} /> 최신 후보가 없어요. 인물 이름이나 분위기를 바꿔 다시 검색해 주세요.</div>}

                <div className={`rights-confirm ${rightsConfirmed ? "confirmed" : ""}`}><button className="check-box" onClick={() => setRightsConfirmed(value => !value)} aria-pressed={rightsConfirmed}>{rightsConfirmed && <Check size={13} />}</button><div><strong>업로드할 미디어의 사용 권한을 확인했어요.</strong><p>직접 제작했거나, 편집·재사용 허가를 받은 파일만 올립니다. 확인은 업로더 자기확인이며 권리를 별도로 검증하지 않아요.</p></div><ShieldCheck size={18} /></div>
                <div className="upload-grid">
                  <button className="upload-tile" onClick={() => videoInput.current?.click()} disabled={!rightsConfirmed || uploading || media.length >= 6}><div className="upload-icon"><UploadCloud size={19} /></div><strong>영상 클립 추가</strong><span>{FORMAT_HINT}</span><div className="upload-cta"><Plus size={14} /> 파일 선택</div></button>
                  <button className="upload-tile audio-tile" onClick={() => audioInput.current?.click()} disabled={!rightsConfirmed || uploading}><div className="upload-icon"><Headphones size={19} /></div><strong>배경음악 추가 <small>선택</small></strong><span>MP3 · M4A · WAV / 최대 80MB</span><div className="upload-cta"><Plus size={14} /> 오디오 선택</div></button>
                  <input ref={videoInput} hidden type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.m4v,.webm" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadFile(file, "video"); event.currentTarget.value = ""; }} />
                  <input ref={audioInput} hidden type="file" accept="audio/mpeg,audio/mp4,audio/wav,audio/aac,.mp3,.m4a,.wav,.aac" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadFile(file, "audio"); event.currentTarget.value = ""; }} />
                </div>
                {uploading && <div className="upload-progress"><LoaderCircle className="spin" size={14} /> 미디어를 임시로 업로드하고 있어요…</div>}
                {uploadMessage && <div className="upload-feedback"><span>{uploadMessage}</span><button onClick={() => setUploadMessage("")} aria-label="알림 닫기"><X size={14} /></button></div>}
                {(media.length > 0 || music) && <div className="media-list">{media.map((item, index) => <div className="media-row" key={item.id}><div className="clip-index">{String(index + 1).padStart(2, "0")}</div><div className="media-icon"><Film size={16} /></div><div className="media-name"><strong>{item.name}</strong><small>사용자 업로드 · 권리 확인됨</small></div><span className="duration-chip">{seconds(item.durationSeconds)}</span><CircleCheck className="permission-check" size={16} /><button className="remove-button" onClick={() => removeVideo(item.id)} aria-label={`${item.name} 제거`}><Trash2 size={14} /></button></div>)}{music && <div className="media-row music-row"><div className="clip-index">♪</div><div className="media-icon music-icon"><Music2 size={16} /></div><div className="media-name"><strong>{music.name}</strong><small>배경음악 · 22% 믹스</small></div><span className="duration-chip">{seconds(music.durationSeconds)}</span><CircleCheck className="permission-check" size={16} /><button className="remove-button" onClick={() => setMusic(null)} aria-label="음악 제거"><Trash2 size={14} /></button></div>}</div>}
                <div className="temporary-note"><AlertCircle size={13} /> 파일은 임시 처리되며 2시간 후 또는 서버 재시작 시 삭제돼요. 프로젝트 이름과 프롬프트만 이 브라우저에 저장됩니다.</div>
              </div>

              <div className="generation-row"><div className="generation-copy"><div className="sparkle-disc"><WandSparkles size={17} /></div><div><strong>AI 편집 구성을 만들 준비가 됐어요</strong><small>{media.length ? `${media.length}개 권리 확인 소스 · ${mood.length >= 3 ? "분위기 프롬프트 입력됨" : "분위기를 3자 이상 입력해 주세요"}` : "먼저 권리 확인된 영상 파일을 추가해 주세요"}</small></div></div><Button className="generate-button" disabled={!person.trim() || mood.trim().length < 3 || !rightsConfirmed || media.length === 0 || createDraft.isPending} onClick={generateDraft}>{createDraft.isPending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{createDraft.isPending ? "타임라인 구성 중…" : "편집 초안 만들기"}</Button></div>
              {createDraft.error && <div className="inline-error draft-error"><AlertCircle size={15} />{createDraft.error.message}</div>}
            </section>

            <aside className="right-column">
              <div className="panel-card preview-card"><div className="preview-heading"><div><span className="eyebrow">PREVIEW MONITOR</span><h2>편집 미리보기</h2></div><span className="aspect-badge">9:16</span></div>
                {videoUrl ? <div className="rendered-preview"><video src={videoUrl} controls playsInline /><a className="download-link" href={videoUrl} download="editmatker-edit.mp4"><ArrowDownToLine size={15} /> MP4 다운로드</a></div> : <div className="preview-stage"><div className="preview-frame"><div className="film-corner top-left" /><div className="film-corner top-right" /><div className="preview-grain" /><div className="preview-placeholder"><div className="preview-play"><Play size={19} fill="currentColor" /></div><span>{draft ? "초안 준비 완료" : "PREVIEW WINDOW"}</span><small>{draft ? "아래에서 미리보기를 렌더링하세요" : "초안을 만들면 여기에 보여요"}</small></div><div className="film-corner bottom-left" /><div className="film-corner bottom-right" /><span className="timecode">00:00:00:00</span></div></div>}
                {draft && <><button className="render-button" disabled={rendering || draft.segments.some(segment => !media.some(item => item.id === segment.assetId))} onClick={renderVideo}>{rendering ? <LoaderCircle className="spin" size={15} /> : <Play size={15} fill="currentColor" />}{rendering ? "영상 렌더링 중…" : draft.segments.some(segment => !media.some(item => item.id === segment.assetId)) ? "원본 다시 업로드 필요" : "미리보기 렌더링"}</button><button className="timeline-json-button" onClick={exportTimeline}><ArrowDownToLine size={13} /> 편집 타임라인 JSON 저장</button></>}
                <div className="preview-foot"><span><span className="green-dot" /> 로컬 프리뷰</span><span>세로 · 540 × 960</span></div>
              </div>

              <div className="panel-card timeline-card"><div className="timeline-heading"><div><span className="eyebrow">EDIT DECISIONS</span><h2>타임라인</h2></div>{draft && <span className="duration-total">{seconds(totalSeconds)}</span>}</div>
                {draft ? <><div className="draft-summary"><strong>{draft.title}</strong><p>{draft.summary}</p></div><div className="timeline-ruler"><span>00:00</span><span>00:06</span><span>00:12</span><span>00:18</span><span>00:24</span></div><div className="timeline-track">{draft.segments.map((segment, index) => { const source = media.find(item => item.id === segment.assetId); return <div className={`timeline-segment segment-${index % 4}`} key={`${segment.assetId}-${index}`} style={{ flex: `${segment.durationSeconds} 1 0%` }} title={`${source?.name ?? "소스"} · ${seconds(segment.durationSeconds)}`}><span>{segment.caption || `컷 ${index + 1}`}</span><small>{seconds(segment.durationSeconds)}</small></div>; })}<div className="playhead" /></div><div className="timeline-legend"><span><i className="legend-video" /> 영상 컷</span><span><i className="legend-line" /> 전환 지점</span></div><div className="scene-list">{draft.segments.map((segment, index) => { const source = media.find(item => item.id === segment.assetId); return <div className="scene-row" key={`${segment.assetId}-scene-${index}`}><span className="scene-number">{String(index + 1).padStart(2, "0")}</span><div className="scene-copy"><strong>{segment.caption || `장면 ${index + 1}`}</strong><small>{source?.name ?? "업로드 소스"} · {seconds(segment.startSeconds)} 시작</small></div><span className="scene-duration">{seconds(segment.durationSeconds)}</span></div>; })}</div><button className="regenerate-link" onClick={generateDraft} disabled={createDraft.isPending}><Sparkles size={14} /> 프롬프트 수정 후 다시 구성</button></> : <div className="timeline-empty"><div className="empty-icon"><AudioLines size={20} /></div><strong>아직 타임라인이 없어요</strong><p>권리 확인된 소스를 추가하고<br />AI 편집 구성을 만들어보세요.</p></div>}
              </div>

              <div className="workflow-card"><div className="workflow-icon"><LockKeyhole size={16} /></div><div><strong>소스 사용 권한은 사용자가 확인해요</strong><p>검색 후보는 참고 링크로만 표시돼요. 허가받은 파일을 업로드해야 타임라인에 포함할 수 있어요.</p></div></div>
            </aside>
          </div>

          <section className="recent-section" id="recent-projects"><div className="recent-header"><div><span className="eyebrow">YOUR RECENT WORK</span><h2>최근 프로젝트</h2></div><span>{saved.length}개 저장됨</span></div>{saved.length ? <div className="recent-list">{saved.map((project, index) => <button className="recent-project" key={`${project.person}-${project.savedAt}`} onClick={() => loadProject(project)}><div className={`recent-cover cover-${index % 3}`}><BrandMark /></div><div className="recent-info"><strong>{project.person} — {project.mood || "새로운 편집"}</strong><small>{new Date(project.savedAt).toLocaleDateString("ko-KR")} · 프롬프트 저장</small></div><ArrowUpRight size={15} /></button>)}</div> : <div className="recent-empty">첫 편집 프로젝트를 시작하면 여기에 기록돼요.</div>}</section>
          <footer className="footer-note"><span>editmatker studio</span><span>검색 자료는 참고 링크 · 미디어는 권리 확인된 업로드만 · 자동 게시 없음</span></footer>
        </div>
      </main>
    </div>
  );
}
