// editmatker 로컬 도우미
//
// 브라우저는 YouTube·Reddit 영상을 직접 내려받을 수 없으므로(CORS, 서명된 스트림 주소),
// 내 컴퓨터에서 yt-dlp로 영상을 받아 웹앱에 넘겨 줍니다.
//
//   pnpm helper            # http://localhost:8787
//
// 필요: yt-dlp (필수), ffmpeg (있으면 영상+소리 병합, 없으면 소리 포함 단일 파일로 받음)
// 환경 변수:
//   EDITMATKER_PORT        포트 (기본 8787)
//   EDITMATKER_YTDLP       yt-dlp 실행 파일 경로 (기본 "yt-dlp")
//   EDITMATKER_YTDLP_ARGS  yt-dlp에 덧붙일 인자 (예: "--cookies-from-browser chrome")
//   EDITMATKER_ORIGINS     추가로 허용할 웹앱 주소 (쉼표 구분)

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.EDITMATKER_PORT) || 8787;
const YTDLP = process.env.EDITMATKER_YTDLP || "yt-dlp";
const EXTRA_ARGS = (process.env.EDITMATKER_YTDLP_ARGS || "").split(/\s+/).filter(Boolean);
const CACHE_DIR = path.join(tmpdir(), "editmatker-cache");
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_FILESIZE = "150M";
const MAX_DURATION = 25 * 60;
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const USER_AGENT = "editmatker/2.0 (local helper)";

const EXTRA_ORIGINS = (process.env.EDITMATKER_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const ORIGIN_PATTERNS = [
  /^https:\/\/editmatker(-[a-z0-9-]+)?\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

export function isAllowedOrigin(origin) {
  return Boolean(origin) && (EXTRA_ORIGINS.includes(origin) || ORIGIN_PATTERNS.some(re => re.test(origin)));
}

/** yt-dlp에 넘길 수 있는 주소는 YouTube·Reddit의 https 주소뿐입니다. */
export function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return ["youtube.com", "youtu.be", "reddit.com", "redd.it"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FORMAT = hasFfmpeg
  ? "bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv*[height<=480]+ba/b[height<=480]/b"
  : "b[height<=480][ext=mp4]/b[ext=mp4]/b";

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [...EXTRA_ARGS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", error => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("yt-dlp가 설치되어 있지 않아요.") : error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().split("\n").pop() || `yt-dlp 종료 코드 ${code}`));
    });
  });
}

async function ytdlpVersion() {
  try {
    return (await run(["--version"], 10_000)).trim();
  } catch {
    return null;
  }
}

async function searchYouTube(query, limit) {
  const out = await run(["--flat-playlist", "--dump-single-json", "--no-warnings", `ytsearch${limit}:${query}`], 30_000);
  const data = JSON.parse(out);
  return (data.entries ?? []).filter(e => e && typeof e.id === "string").map(e => ({
    id: e.id,
    title: e.title,
    channel: e.channel ?? e.uploader ?? null,
    duration: e.duration ?? null,
    url: e.url?.startsWith("http") ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    thumbnail: [...(e.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
    live: e.live_status === "is_live" || e.live_status === "is_upcoming",
  }));
}

async function searchReddit(query, limit) {
  const url = new URL("https://www.reddit.com/search.json");
  url.search = new URLSearchParams({ q: query, sort: "relevance", t: "all", type: "link", limit: String(limit), raw_json: "1" }).toString();
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Reddit 응답 오류 (${response.status})`);
  return response.json();
}

const downloads = new Map();

async function downloadMedia(mediaUrl) {
  const key = createHash("sha1").update(mediaUrl).digest("hex").slice(0, 20);
  await mkdir(CACHE_DIR, { recursive: true });
  const existing = (await readdir(CACHE_DIR)).find(name => name.startsWith(`${key}.`) && !name.endsWith(".part"));
  if (existing) return path.join(CACHE_DIR, existing);
  if (!downloads.has(key)) {
    const job = (async () => {
      const out = await run(
        [
          "-f", FORMAT,
          ...(hasFfmpeg ? ["--merge-output-format", "mp4"] : []),
          "--max-filesize", MAX_FILESIZE,
          "--match-filters", `duration <=? ${MAX_DURATION} & !is_live`,
          "--no-playlist",
          "--no-warnings",
          "-o", path.join(CACHE_DIR, `${key}.%(ext)s`),
          "--print", "after_move:filepath",
          mediaUrl,
        ],
        5 * 60_000
      );
      const file = out.trim().split("\n").filter(Boolean).pop();
      if (!file || !existsSync(file)) throw new Error("영상이 너무 길거나 커서 받지 않았어요.");
      return file;
    })().finally(() => downloads.delete(key));
    downloads.set(key, job);
  }
  return downloads.get(key);
}

async function cleanCache() {
  const now = Date.now();
  for (const name of await readdir(CACHE_DIR).catch(() => [])) {
    const file = path.join(CACHE_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > CACHE_TTL_MS) await rm(file, { force: true });
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };

async function serveStatic(req, res, pathname) {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("웹앱이 아직 빌드되지 않았어요. `pnpm build`를 먼저 실행하세요.");
  }
  const target = path.resolve(DIST_DIR, `.${decodeURIComponent(pathname)}`);
  const file = target.startsWith(DIST_DIR) && existsSync(target) && (await stat(target)).isFile() ? target : path.join(DIST_DIR, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createHelperServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length");
    } else if (origin && url.pathname.startsWith("/api/")) {
      return sendJson(res, 403, { error: "허용되지 않은 웹앱 주소예요." });
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET");
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== "GET") return sendJson(res, 405, { error: "GET만 지원해요." });

    try {
      if (url.pathname === "/api/health") {
        const version = await ytdlpVersion();
        return sendJson(res, 200, { ok: true, ytDlp: version, ffmpeg: hasFfmpeg });
      }
      if (url.pathname === "/api/youtube/search" || url.pathname === "/api/reddit/search") {
        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
        const limit = Math.min(25, Math.max(1, Number(url.searchParams.get("limit")) || 12));
        if (!q) return sendJson(res, 400, { error: "검색어가 비어 있어요." });
        const result = url.pathname.startsWith("/api/youtube") ? { entries: await searchYouTube(q, limit) } : await searchReddit(q, limit);
        return sendJson(res, 200, result);
      }
      if (url.pathname === "/api/media") {
        const mediaUrl = url.searchParams.get("url") ?? "";
        if (!isAllowedMediaUrl(mediaUrl)) return sendJson(res, 400, { error: "YouTube·Reddit 주소만 받을 수 있어요." });
        const file = await downloadMedia(mediaUrl);
        const info = await stat(file);
        res.writeHead(200, { "Content-Type": file.endsWith(".webm") ? "video/webm" : "video/mp4", "Content-Length": info.size, "Cache-Control": "no-store" });
        return createReadStream(file).pipe(res);
      }
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "없는 경로예요." });
      return serveStatic(req, res, url.pathname);
    } catch (error) {
      return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(CACHE_DIR, { recursive: true });
  await cleanCache();
  setInterval(cleanCache, 10 * 60_000).unref();
  const version = await ytdlpVersion();
  createHelperServer().listen(PORT, "127.0.0.1", () => {
    console.log(`editmatker 로컬 도우미: http://localhost:${PORT}`);
    console.log(version ? `  yt-dlp ${version} · ffmpeg ${hasFfmpeg ? "있음" : "없음 (단일 파일 형식으로 받음)"}` : "  ⚠ yt-dlp를 찾지 못했어요. https://github.com/yt-dlp/yt-dlp#installation 을 참고해 설치하세요.");
    console.log("  웹앱(https://editmatker.vercel.app 또는 이 주소)에서 YouTube·Reddit 영상을 쓸 수 있어요.");
  });
}
