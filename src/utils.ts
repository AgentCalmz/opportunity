import type { JobOpportunity, RemoteStatus, SearchOptions } from "./types.js";

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter(Boolean);
}

export function stripHtml(value: unknown): string {
  return asString(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|section|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = typeof value === "number"
    ? new Date(value < 10_000_000_000 ? value * 1000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function inferRemoteStatus(explicit: unknown, location: string, text = ""): RemoteStatus {
  if (typeof explicit === "boolean") return explicit ? "remote" : "onsite";
  const combined = `${location} ${text}`.toLowerCase();
  if (/\bhybrid\b/.test(combined)) return "hybrid";
  if (/\b(remote|work from home|work-from-home|anywhere in the world|distributed team|fully distributed)\b/.test(combined)) return "remote";
  return "unknown";
}

export function makeJob(input: {
  id: unknown;
  title: unknown;
  company: unknown;
  location?: unknown;
  explicitRemote?: unknown;
  description?: unknown;
  summary?: unknown;
  publishedAt?: unknown;
  employmentType?: unknown;
  seniority?: unknown;
  tags?: unknown;
  salaryMin?: unknown;
  salaryMax?: unknown;
  salaryCurrency?: unknown;
  salaryPeriod?: unknown;
  jobUrl: unknown;
  applyUrl?: unknown;
  sourceName: string;
  sourceId: string;
}): JobOpportunity | undefined {
  const title = asString(input.title);
  const company = asString(input.company, "Company not listed");
  const jobUrl = asString(input.jobUrl);
  if (!title || !jobUrl) return undefined;

  const location = asString(input.location, "Location not specified");
  const description = stripHtml(input.description);
  const summary = stripHtml(input.summary) || description.slice(0, 420);
  const tags = Array.isArray(input.tags)
    ? asStringArray(input.tags)
    : asString(input.tags).split(/[,|]/).map((v) => v.trim()).filter(Boolean);
  const publishedAt = parseDate(input.publishedAt);
  const salaryMin = asNumber(input.salaryMin);
  const salaryMax = asNumber(input.salaryMax);
  const applyUrl = asString(input.applyUrl);
  const employmentType = asString(input.employmentType);
  const seniority = asString(input.seniority);
  const salaryCurrency = asString(input.salaryCurrency);
  const salaryPeriod = asString(input.salaryPeriod);

  const result: JobOpportunity = {
    id: asString(input.id, jobUrl),
    title,
    company,
    location,
    remoteStatus: inferRemoteStatus(input.explicitRemote, location, `${title} ${summary}`),
    description,
    summary,
    tags,
    jobUrl,
    sourceName: input.sourceName,
    sourceUrl: jobUrl,
    sourceId: input.sourceId
  };
  if (publishedAt) result.publishedAt = publishedAt;
  if (employmentType) result.employmentType = employmentType;
  if (seniority) result.seniority = seniority;
  if (salaryMin !== undefined && salaryMin > 0) result.salaryMin = salaryMin;
  if (salaryMax !== undefined && salaryMax > 0) result.salaryMax = salaryMax;
  if (salaryCurrency) result.salaryCurrency = salaryCurrency;
  if (salaryPeriod) result.salaryPeriod = salaryPeriod;
  if (applyUrl) result.applyUrl = applyUrl;
  return result;
}

export function normalizedText(value: string): string {
  return value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function matchesQuery(job: JobOpportunity, query: string): boolean {
  const terms = normalizedText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalizedText([
    job.title,
    job.company,
    job.location,
    job.description,
    job.summary,
    job.employmentType ?? "",
    ...job.tags
  ].join(" "));
  return terms.every((term) => haystack.includes(term));
}

export function matchesLocation(job: JobOpportunity, desiredLocation?: string): boolean {
  if (!desiredLocation) return true;
  const wanted = normalizedText(desiredLocation);
  const listed = normalizedText(job.location);
  if (!wanted) return true;
  if (listed.includes(wanted)) return true;
  return /\b(anywhere|worldwide|global|all countries|everywhere)\b/.test(listed);
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_.+|ref|source|campaign|gh_src)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().replace(/\/$/, "").toLowerCase();
  }
}

export function deduplicate(jobs: JobOpportunity[]): { jobs: JobOpportunity[]; removed: number } {
  const result: JobOpportunity[] = [];
  const seenUrl = new Set<string>();
  const seenFingerprint = new Set<string>();

  for (const job of jobs) {
    const urlKey = canonicalUrl(job.jobUrl);
    const fingerprint = [
      normalizedText(job.company),
      normalizedText(job.title),
      normalizedText(job.location)
    ].join("|");
    if (seenUrl.has(urlKey) || seenFingerprint.has(fingerprint)) continue;
    seenUrl.add(urlKey);
    seenFingerprint.add(fingerprint);
    result.push(job);
  }
  return { jobs: result, removed: jobs.length - result.length };
}

export function isWithinTimeframe(job: JobOpportunity, options: SearchOptions, now = new Date()): boolean | "unknown-date" {
  let cutoff: Date | undefined;
  if (options.since) {
    const parsed = new Date(options.since);
    if (!Number.isNaN(parsed.getTime())) cutoff = parsed;
  } else if (options.days !== undefined) {
    cutoff = new Date(now.getTime() - options.days * 24 * 60 * 60 * 1000);
  }
  if (!cutoff) return true;
  if (!job.publishedAt) return "unknown-date";
  return new Date(job.publishedAt).getTime() >= cutoff.getTime();
}

export function formatTimeframe(options: SearchOptions): string {
  if (options.since) return `since ${options.since}`;
  if (options.days !== undefined) return `last ${options.days} day(s)`;
  return "all dates available from each source";
}

export function sortNewestFirst(jobs: JobOpportunity[]): JobOpportunity[] {
  return [...jobs].sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bTime - aTime;
  });
}
