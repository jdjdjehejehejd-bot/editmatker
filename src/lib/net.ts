// 네트워크 요청에 시간 제한을 둡니다. 한 사이트가 응답하지 않으면 전체 작업이 끝없이 기다리던 문제를 막습니다.

/** 시간 제한을 넘겼을 때의 오류 (어느 요청이 느렸는지 알 수 있게) */
export class TimeoutError extends Error {
  constructor(seconds: number) {
    super(`응답이 너무 느려요 (${seconds}초 넘게 기다림)`);
    this.name = "TimeoutError";
  }
}

/**
 * 부모 신호(사용자가 중단)와 시간 제한을 합친 신호. AbortSignal.any가 없는 예전 안드로이드 브라우저에서도 동작하게 직접 묶습니다.
 * done()을 부르면 타이머와 연결을 정리합니다.
 */
export function timeoutSignal(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new TimeoutError(Math.round(ms / 1000)));
  }, ms);
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => expired,
  };
}

/** 시간 제한이 있는 fetch. 시간을 넘기면 TimeoutError, 사용자가 중단하면 원래 중단 오류를 던집니다. */
export async function fetchWithTimeout(url: string, init: RequestInit & { signal?: AbortSignal } = {}, ms = 15_000): Promise<Response> {
  const limit = timeoutSignal(init.signal, ms);
  try {
    return await fetch(url, { ...init, signal: limit.signal });
  } catch (error) {
    if (limit.timedOut() && !init.signal?.aborted) throw new TimeoutError(Math.round(ms / 1000));
    throw error;
  } finally {
    limit.done();
  }
}

/** 약속(promise)에 시간 제한을 둡니다(안의 작업은 따로 멈추지 않음 — 결과만 기다리지 않음). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(Math.round(ms / 1000))), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
