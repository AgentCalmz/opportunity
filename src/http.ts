import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CacheRecord {
  cachedAt: number;
  body: string;
}

export interface TextResponse {
  body: string;
  fromCache: boolean;
  cachedAt?: string;
}

export interface RequestOptions {
  ttlMs?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function cacheDirectory(): string {
  return process.env.OPPORTUNITY_CACHE_DIR?.trim() || ".opportunity-cache";
}

function cacheFileFor(url: string): string {
  const key = createHash("sha256").update(url).digest("hex");
  return path.join(process.cwd(), cacheDirectory(), `${key}.json`);
}

async function readFreshCache(file: string, ttlMs: number): Promise<CacheRecord | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    const record = JSON.parse(raw) as CacheRecord;
    if (typeof record.cachedAt !== "number" || typeof record.body !== "string") return undefined;
    if (Date.now() - record.cachedAt > ttlMs) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, record: CacheRecord): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(record), "utf8");
  } catch {
    // Cache storage is an optimization. A read-only directory must not break search.
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return Math.min(1000 * (2 ** attempt), 8000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getText(url: string, options: RequestOptions = {}): Promise<TextResponse> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const file = cacheFileFor(url);
  const cached = await readFreshCache(file, ttlMs);
  if (cached) {
    return {
      body: cached.body,
      fromCache: true,
      cachedAt: new Date(cached.cachedAt).toISOString()
    };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Accept": "application/json, application/rss+xml, application/xml, text/xml, text/plain, */*",
          "User-Agent": "Opportunity/0.1 (public job discovery; https://github.com/AgentCalmz/opportunity)",
          ...options.headers
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000)
      });

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const delay = retryDelayMs(response, attempt);
        // Do not leave an interactive search hanging for a long provider Retry-After.
        if (delay > 20_000) {
          throw new Error(`HTTP ${response.status}; provider asked the client to retry after ${Math.ceil(delay / 1000)} seconds`);
        }
        await sleep(delay);
        continue;
      }
      if (!response.ok) {
        const retryAfter = response.headers.get("retry-after");
        throw new Error(`HTTP ${response.status}${retryAfter ? ` (Retry-After: ${retryAfter})` : ""}`);
      }

      const body = await response.text();
      await writeCache(file, { cachedAt: Date.now(), body });
      return { body, fromCache: false };
    } catch (error) {
      lastError = error;
      if (attempt < 2 && error instanceof Error && /fetch failed|network|timeout|ECONNRESET|ENOTFOUND/i.test(error.message)) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (attempt >= 2) break;
      // HTTP status failures have already passed through the retry branch above;
      // do not retry deterministic errors such as 400 or 403.
      break;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown request failure");
  throw new Error(`Request failed for ${new URL(url).hostname}: ${message}`);
}

export async function getJson(url: string, options: RequestOptions = {}): Promise<{ data: unknown; fromCache: boolean; cachedAt?: string }> {
  const response = await getText(url, options);
  try {
    return {
      data: JSON.parse(response.body) as unknown,
      fromCache: response.fromCache,
      ...(response.cachedAt ? { cachedAt: response.cachedAt } : {})
    };
  } catch {
    throw new Error(`Invalid JSON returned by ${new URL(url).hostname}`);
  }
}