import type { Request, RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function clientKey(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 10 * 60 * 1000);
cleanup.unref();

export function rateLimit(name: string, maxRequests: number, windowMs: number): RequestHandler {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${clientKey(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: "요청이 잠시 몰렸어요. 잠시 후 다시 시도해 주세요." });
      return;
    }
    next();
  };
}
