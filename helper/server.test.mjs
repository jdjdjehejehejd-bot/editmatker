import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 실제 네트워크 없이 도우미를 시험하기 위한 가짜 yt-dlp
const dir = mkdtempSync(path.join(tmpdir(), "editmatker-helper-"));
const fake = path.join(dir, "yt-dlp");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2099.01.01"); process.exit(0); }
if (args.includes("--dump-single-json")) {
  console.log(JSON.stringify({ entries: [{ id: "abc", title: "Clip", channel: "Ch", duration: 42, thumbnails: [{ url: "t.jpg", width: 10 }] }] }));
  process.exit(0);
}
const out = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4");
require("fs").writeFileSync(out, "FAKEVIDEO");
console.log(out);
`
);
chmodSync(fake, 0o755);
process.env.EDITMATKER_YTDLP = fake;

let server;
let base;
let helper;

beforeAll(async () => {
  helper = await import("./server.mjs");
  server = helper.createHelperServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const vercel = { headers: { Origin: "https://editmatker.vercel.app" } };

describe("로컬 도우미", () => {
  it("허용된 출처와 주소만 받는다", () => {
    expect(helper.isAllowedOrigin("https://editmatker.vercel.app")).toBe(true);
    expect(helper.isAllowedOrigin("https://editmatker-git-main-x.vercel.app")).toBe(true);
    expect(helper.isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(helper.isAllowedOrigin("https://evil.example")).toBe(false);
    expect(helper.isAllowedMediaUrl("https://www.youtube.com/watch?v=a")).toBe(true);
    expect(helper.isAllowedMediaUrl("https://www.reddit.com/r/x/comments/1/")).toBe(true);
    expect(helper.isAllowedMediaUrl("https://v.redd.it/abc")).toBe(true);
    expect(helper.isAllowedMediaUrl("http://www.youtube.com/watch?v=a")).toBe(false);
    expect(helper.isAllowedMediaUrl("https://youtube.com.evil.example/")).toBe(false);
    expect(helper.isAllowedMediaUrl("file:///etc/passwd")).toBe(false);
  });

  it("상태 확인에 yt-dlp 버전과 CORS 헤더를 돌려준다", async () => {
    const response = await fetch(`${base}/api/health`, vercel);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://editmatker.vercel.app");
    expect(await response.json()).toMatchObject({ ok: true, ytDlp: "2099.01.01" });
  });

  it("다른 사이트의 요청은 거부한다", async () => {
    const response = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  it("YouTube 검색 결과를 정리해 돌려준다", async () => {
    const data = await (await fetch(`${base}/api/youtube/search?q=test`, vercel)).json();
    expect(data.entries[0]).toMatchObject({ id: "abc", title: "Clip", channel: "Ch", duration: 42, url: "https://www.youtube.com/watch?v=abc", thumbnail: "t.jpg" });
  });

  it("영상을 받아 그대로 넘겨주고, 허용되지 않은 주소는 거부한다", async () => {
    const ok = await fetch(`${base}/api/media?url=${encodeURIComponent("https://www.youtube.com/watch?v=abc")}`, vercel);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("video/mp4");
    expect(await ok.text()).toBe("FAKEVIDEO");
    const bad = await fetch(`${base}/api/media?url=${encodeURIComponent("https://example.com/a.mp4")}`, vercel);
    expect(bad.status).toBe(400);
  });
});
