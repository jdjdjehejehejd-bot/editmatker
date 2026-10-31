import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, TimeoutError, withTimeout } from "./net";

describe("시간 제한", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    vi.useRealTimers();
  });

  it("응답하지 않는 요청은 시간 제한 오류로 끝남", async () => {
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    await expect(fetchWithTimeout("https://example.com", {}, 30)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("사용자가 중단하면 시간 제한이 아니라 중단으로", async () => {
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const controller = new AbortController();
    const pending = fetchWithTimeout("https://example.com", { signal: controller.signal }, 5000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("제때 오면 그대로", async () => {
    globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
    expect(await (await fetchWithTimeout("https://example.com", {}, 1000)).text()).toBe("ok");
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toBeInstanceOf(TimeoutError);
  });
});
