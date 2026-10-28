import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import express, { type Express, type Request, type Response } from "express";

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const ASSET_TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map<string, number>();
const assets = new Map<string, { filePath: string; name: string; kind: "video" | "audio"; duration: number; createdAt: number; ownerToken: string }>();
const allowedExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav", ".aac"]);

type SearchVideo = { id: string; title: string; channel: string; published: string; duration: number | null; views: number | null; thumbnail: string | null; url: string; rightsStatus: "unverified" };

function run(command: string, args: string[], timeoutMs = 30_000) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => (stdout += chunk.toString()));
    child.stderr.on("data", chunk => (stderr += chunk.toString()));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.slice(-1200) || `${command} exited with ${code}`));
    });
  });
}

function cleanExpiredAssets() {
  const now = Date.now();
  const cutoff = now - ASSET_TTL_MS;
  for (const [token, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(token);
  for (const [id, asset] of assets) {
    if (asset.createdAt < cutoff || !sessions.has(asset.ownerToken)) {
      assets.delete(id);
      void rm(path.dirname(asset.filePath), { recursive: true, force: true });
    }
  }
}

function isMediaSession(token: string | undefined): token is string {
  const expiresAt = token ? sessions.get(token) : undefined;
  return expiresAt !== undefined && expiresAt > Date.now();
}

const cleanupTimer = setInterval(cleanExpiredAssets, 10 * 60 * 1000);
cleanupTimer.unref();

function parseApiData(value: unknown): any {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value && typeof value === "object" && "jsonData" in value) return parseApiData((value as { jsonData: unknown }).jsonData);
  return value;
}

const searchResultSchema = z.object({
  person: z.string().trim().min(1).max(100),
  mood: z.string().trim().max(500).default(""),
});

export async function searchPublicVideos(input: z.infer<typeof searchResultSchema>) {
  const apiUrl = process.env.MANUS_API_URL;
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiUrl || !apiKey) throw new Error("공개 영상 검색 서비스가 아직 연결되지 않았어요.");
  const query = `${input.person} ${input.mood}`.trim();
  const response = await fetch(`${apiUrl}/webdevtoken.v1.WebDevService/CallApi`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "connect-protocol-version": "1",
    },
    body: JSON.stringify({ apiId: "Youtube/search", query: { q: query, type: "video", order: "date", maxResults: "8" } }),
    signal: AbortSignal.timeout(18_000),
  });
  const raw = await response.json().catch(() => null) as any;
  if (!response.ok || raw?.error || raw?.code) {
    throw new Error(raw?.message || raw?.error?.message || "최신 자료 검색에 실패했어요. 잠시 후 다시 시도해 주세요.");
  }
  const data = parseApiData(raw);
  const rows = Array.isArray(data?.contents) ? data.contents : Array.isArray(data?.items) ? data.items : [];
  const videos: SearchVideo[] = rows.flatMap((row: any) => {
    const video = row?.video ?? row;
    const id = video?.videoId ?? video?.id?.videoId;
    if (typeof id !== "string" || !id) return [];
    return [{
      id,
      title: String(video.title ?? "제목 없음").slice(0, 240),
      channel: String(video.author?.title ?? video.channelTitle ?? "채널 정보 없음").slice(0, 120),
      published: String(video.publishedTimeText ?? video.publishedAt ?? "게시일 정보 없음").slice(0, 80),
      duration: Number(video.lengthSeconds) || null,
      views: Number(video.stats?.views) || null,
      thumbnail: video.thumbnails?.at(-1)?.url ?? video.movingThumbnails?.[0]?.url ?? null,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      rightsStatus: "unverified" as const,
    }];
  }).slice(0, 8);
  return videos;
}

const draftInputSchema = z.object({
  mediaSession: z.string().min(32).max(128),
  person: z.string().trim().min(1).max(100),
  mood: z.string().trim().min(3).max(500),
  assetIds: z.array(z.string().uuid()).min(1).max(6),
  durationSeconds: z.number().int().min(8).max(60).default(24),
});

export async function createEditDraft(input: z.infer<typeof draftInputSchema>) {
  cleanExpiredAssets();
  if (!isMediaSession(input.mediaSession)) throw new Error("편집 세션이 만료됐어요. 페이지를 새로고침해 주세요.");
  const selected = input.assetIds.map(id => ({ id, asset: assets.get(id) }));
  if (selected.some(item => !item.asset || item.asset.kind !== "video" || item.asset.ownerToken !== input.mediaSession)) {
    throw new Error("업로드 영상이 만료되었거나 편집할 수 없어요. 파일을 다시 올려 주세요.");
  }
  const apiUrl = process.env.MANUS_API_URL;
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiUrl || !apiKey) throw new Error("AI 편집 서비스가 아직 연결되지 않았어요.");

  const available = selected.map(({ id, asset }) => ({
    id,
    fileName: asset!.name,
    durationSeconds: Math.floor(asset!.duration),
  }));
  const prompt = `사용자가 권리를 확인하고 업로드한 미디어만 사용해 세로형 팬 edit의 편집 타임라인을 설계하세요. 인물: ${input.person}. 분위기 지시: ${input.mood}. 목표 길이: ${input.durationSeconds}초. 사용 가능 소스(JSON): ${JSON.stringify(available)}. JSON 객체만 반환: {"title":string,"summary":string,"segments":[{"assetId":string,"startSeconds":number,"durationSeconds":number,"caption":string,"transition":"cut"|"fade"}]}. 2~6개 장면, 각 장면은 파일 길이를 넘지 않는 시작점과 1.5~6초의 컷 길이를 사용하세요. 캡션은 짧은 한국어 한 줄, 인물의 사생활/사실을 창작하지 마세요. 합계는 목표 길이에 가깝게 조정하고 assetId는 제공된 것만 사용하세요.`;
  const response = await fetch(`${apiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: "당신은 세심한 영상 편집자입니다. 사용자가 제공한 권리 확인 미디어의 메타데이터만 기반으로 컷 구성을 제안하세요. 출력은 JSON 객체 하나만 반환합니다." },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json().catch(() => null) as any;
  if (!response.ok || result?.error) throw new Error(result?.error?.message || "AI 편집 구성을 만들지 못했어요. 다시 시도해 주세요.");
  const text = result?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI가 편집 구성을 반환하지 않았어요. 다시 시도해 주세요.");
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: any;
  try { parsed = JSON.parse(clean); } catch { throw new Error("AI 편집 결과를 읽지 못했어요. 프롬프트를 조금 바꿔 다시 시도해 주세요."); }
  const segmentSchema = z.object({
    assetId: z.string().uuid(),
    startSeconds: z.number().min(0),
    durationSeconds: z.number().min(1.5).max(6),
    caption: z.string().max(80).default(""),
    transition: z.enum(["cut", "fade"]).default("cut"),
  });
  const draftSchema = z.object({ title: z.string().min(1).max(100), summary: z.string().max(300), segments: z.array(segmentSchema).min(1).max(6) });
  const draft = draftSchema.parse(parsed);
  const allowed = new Set(input.assetIds);
  if (draft.segments.some((segment: z.infer<typeof segmentSchema>) => {
    const asset = assets.get(segment.assetId);
    return !allowed.has(segment.assetId) || !asset || asset.ownerToken !== input.mediaSession || segment.startSeconds + segment.durationSeconds > asset.duration + 0.25;
  })) throw new Error("AI 편집 결과가 업로드 영상의 길이 범위를 벗어났어요. 다시 생성해 주세요.");
  return draft;
}

const renderSchema = z.object({
  mediaSession: z.string().min(32).max(128),
  segments: z.array(z.object({
    assetId: z.string().uuid(), startSeconds: z.number().min(0), durationSeconds: z.number().min(1).max(12), caption: z.string().max(80).default(""), transition: z.enum(["cut", "fade"]).default("cut"),
  })).min(1).max(6),
  musicAssetId: z.string().uuid().optional(),
});

function setDownloadHeaders(res: Response) {
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="editmatker-edit.mp4"');
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function registerMediaRoutes(app: Express) {
  app.post("/api/media/session", (_req: Request, res: Response) => {
    cleanExpiredAssets();
    if (sessions.size >= 10_000) return res.status(503).json({ error: "편집 세션이 가득 찼어요. 잠시 후 다시 시도해 주세요." });
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, Date.now() + ASSET_TTL_MS);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ mediaSession: token, expiresInSeconds: Math.floor(ASSET_TTL_MS / 1000) });
  });
  app.post("/api/media/upload", express.raw({ type: ["video/*", "audio/*", "application/octet-stream"], limit: "80mb" }), async (req: Request, res: Response) => {
    try {
      cleanExpiredAssets();
      if (req.header("x-rights-confirmed") !== "true") return res.status(400).json({ error: "권리 확인에 동의한 파일만 올릴 수 있어요." });
      const ownerToken = req.header("x-media-session") || undefined;
      if (!isMediaSession(ownerToken)) return res.status(401).json({ error: "편집 세션이 만료됐어요. 페이지를 새로고침해 주세요." });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "업로드된 파일이 비어 있어요." });
      if (req.body.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: "파일은 80MB 이하로 업로드해 주세요." });
      if ([...assets.values()].filter(asset => asset.ownerToken === ownerToken).length >= 12) return res.status(429).json({ error: "임시 업로드가 가득 찼어요. 잠시 뒤 다시 시도해 주세요." });
      const originalName = decodeURIComponent(req.header("x-file-name") || "media").slice(0, 160);
      const extension = path.extname(originalName).toLowerCase();
      if (!allowedExtensions.has(extension)) return res.status(415).json({ error: "MP4, MOV, M4V, WebM 또는 MP3, M4A, WAV, AAC 파일을 지원해요." });
      const mime = req.header("content-type") || "application/octet-stream";
      const isAudio = mime.startsWith("audio/") || [".mp3", ".m4a", ".wav", ".aac"].includes(extension);
      const id = randomUUID();
      const folder = await mkdtemp(path.join(tmpdir(), "editmatker-"));
      const filePath = path.join(folder, `source${extension}`);
      await writeFile(filePath, req.body, { flag: "wx" });
      const probe = await run(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath], 15_000);
      const duration = Number(JSON.parse(probe.stdout)?.format?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || (!isAudio && duration > 1800)) {
        await rm(folder, { recursive: true, force: true });
        return res.status(400).json({ error: "파일의 길이를 확인할 수 없거나 30분을 초과해요." });
      }
      const asset = { filePath, name: path.basename(originalName), kind: isAudio ? "audio" as const : "video" as const, duration, createdAt: Date.now(), ownerToken };
      assets.set(id, asset);
      return res.json({ id, name: asset.name, kind: asset.kind, durationSeconds: Math.floor(duration) });
    } catch (error) {
      console.error("Media upload failed:", error instanceof Error ? error.message : "unknown error");
      return res.status(400).json({ error: "이 파일을 읽지 못했어요. 지원되는 미디어인지 확인해 주세요." });
    }
  });

  app.post("/api/media/render", async (req: Request, res: Response) => {
    let workDir = "";
    try {
      cleanExpiredAssets();
      const input = renderSchema.parse(req.body);
      if (!isMediaSession(input.mediaSession)) return res.status(401).json({ error: "편집 세션이 만료됐어요. 페이지를 새로고침해 주세요." });
      const selected = input.segments.map(segment => ({ segment, asset: assets.get(segment.assetId) }));
      if (selected.some(item => !item.asset || item.asset.ownerToken !== input.mediaSession || item.asset.kind !== "video" || item.segment.startSeconds + item.segment.durationSeconds > item.asset.duration + 0.25)) {
        return res.status(400).json({ error: "편집에 필요한 원본 영상이 만료되었거나 컷 길이가 원본을 넘었어요." });
      }
      const totalDuration = selected.reduce((sum, item) => sum + item.segment.durationSeconds, 0);
      if (totalDuration > 60) return res.status(400).json({ error: "한 번에 내보낼 수 있는 편집은 60초 이하여야 해요." });
      const music = input.musicAssetId ? assets.get(input.musicAssetId) : undefined;
      if (input.musicAssetId && (music?.kind !== "audio" || music.ownerToken !== input.mediaSession)) return res.status(400).json({ error: "배경 음악 파일이 만료되었어요. 다시 올려 주세요." });
      workDir = await mkdtemp(path.join(tmpdir(), "editmatker-render-"));
      const clipPaths: string[] = [];
      for (let index = 0; index < selected.length; index += 1) {
        const { segment, asset } = selected[index];
        const output = path.join(workDir, `clip-${index}.mp4`);
        let filter = "scale=540:960:force_original_aspect_ratio=increase,crop=540:960,setsar=1,format=yuv420p";
        if (segment.transition === "fade") {
          filter += `,fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, segment.durationSeconds - 0.25)}:d=0.25`;
        }
        const args = ["-y", "-ss", String(segment.startSeconds), "-i", asset!.filePath, "-t", String(segment.durationSeconds), "-vf", filter];
        if (segment.caption.trim()) {
          const captionPath = path.join(workDir, `caption-${index}.txt`);
          await writeFile(captionPath, segment.caption.replace(/[\r\n]+/g, " ").trim(), "utf8");
          filter += `,drawtext=fontfile=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc:textfile=${captionPath}:fontcolor=white:fontsize=34:box=1:boxcolor=black@0.55:boxborderw=12:x=(w-text_w)/2:y=h*0.78`;
        }
        args[args.indexOf("-vf") + 1] = filter;
        args.push("-an", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output);
        await run(process.env.FFMPEG_PATH || "ffmpeg", args, 120_000);
        clipPaths.push(output);
      }
      const listPath = path.join(workDir, "clips.txt");
      await writeFile(listPath, clipPaths.map(file => `file '${file}'`).join("\n"), "utf8");
      const joinedPath = path.join(workDir, "joined.mp4");
      await run(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", joinedPath], 60_000);
      const outputPath = path.join(workDir, "editmatker-edit.mp4");
      if (music) {
        const fadeStart = Math.max(0, totalDuration - 2);
        await run(process.env.FFMPEG_PATH || "ffmpeg", ["-y", "-i", joinedPath, "-stream_loop", "-1", "-i", music.filePath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", `volume=0.22,afade=t=out:st=${fadeStart}:d=${Math.min(2, totalDuration)}`, "-shortest", "-movflags", "+faststart", outputPath], 60_000);
      } else {
        await writeFile(outputPath, await import("node:fs/promises").then(fs => fs.readFile(joinedPath)));
      }
      setDownloadHeaders(res);
      const stream = createReadStream(outputPath);
      stream.on("error", () => { if (!res.headersSent) res.status(500).json({ error: "내보낸 영상을 읽을 수 없어요." }); else res.destroy(); });
      stream.on("close", () => { if (workDir) void rm(workDir, { recursive: true, force: true }); });
      stream.pipe(res);
    } catch (error) {
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      console.error("Media render failed:", error instanceof Error ? error.message : "unknown error");
      const message = error instanceof z.ZodError ? "편집 타임라인 형식이 올바르지 않아요." : "영상 렌더링에 실패했어요. 업로드한 파일을 확인한 뒤 다시 시도해 주세요.";
      if (!res.headersSent) return res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
    }
  });
}

export const editmakerSchemas = { search: searchResultSchema, draft: draftInputSchema };
