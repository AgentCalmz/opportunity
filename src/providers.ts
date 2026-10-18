import { XMLParser } from "fast-xml-parser";
import type { SearchOptions, SourceResult, JobOpportunity } from "./types.js";
import { asObject, asString, makeJob, parseDate, stripHtml } from "./utils.js";
import { getJson, getText } from "./http.js";

const HOUR = 60 * 60 * 1000;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  trimValues: true
});

function result(
  sourceId: string,
  sourceName: string,
  jobs: JobOpportunity[],
  cacheUsed: boolean,
  message?: string,
  partial = false
): SourceResult {
  return {
    sourceId,
    sourceName,
    status: partial ? "partial" : "ok",
    jobs,
    fetchedAt: new Date().toISOString(),
    cacheUsed,
    ...(message ? { message } : {})
  };
}

function failed(sourceId: string, sourceName: string, error: unknown): SourceResult {
  return {
    sourceId,
    sourceName,
    status: "error",
    jobs: [],
    fetchedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error)
  };
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function flattenTags(...values: unknown[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const text = asString(entry);
        if (text) tags.push(text);
      }
    } else {
      const text = asString(value);
      if (text) tags.push(text);
    }
  }
  return [...new Set(tags)];
}

function cutoffDate(options: SearchOptions): number | undefined {
  if (options.since) {
    const date = Date.parse(options.since);
    return Number.isFinite(date) ? date : undefined;
  }
  if (options.days !== undefined) return Date.now() - options.days * 86_400_000;
  return undefined;
}

function olderThanCutoff(raw: unknown, cutoff: number): boolean {
  const job = asObject(raw);
  const date = parseDate(job.created_at ?? job.pubDate ?? job.date ?? job.epoch);
  return date !== undefined && Date.parse(date) < cutoff;
}

function mapJobicy(raw: unknown): JobOpportunity | undefined {
  const j = asObject(raw);
  return makeJob({
    id: j.id ?? j.jobSlug,
    title: j.jobTitle,
    company: j.companyName,
    location: j.jobGeo ?? "Remote",
    explicitRemote: true,
    description: j.jobDescription,
    summary: j.jobExcerpt,
    publishedAt: j.pubDate,
    employmentType: flattenTags(j.jobType).join(", "),
    seniority: j.jobLevel,
    tags: flattenTags(j.jobIndustry, j.jobType, j.jobLevel),
    salaryMin: j.salaryMin,
    salaryMax: j.salaryMax,
    salaryCurrency: j.salaryCurrency,
    salaryPeriod: j.salaryPeriod,
    jobUrl: j.url,
    applyUrl: j.url,
    sourceName: "Jobicy",
    sourceId: "jobicy"
  });
}

async function fetchJobicy(options: SearchOptions): Promise<SourceResult> {
  const sourceId = "jobicy";
  const sourceName = "Jobicy";
  try {
    const jobs: JobOpportunity[] = [];
    const cutoff = cutoffDate(options);
    let cursor = "";
    let cacheUsed = true;
    let partial = false;
    let pages = 0;
    const maxPages = 25;

    while (pages < maxPages) {
      const url = new URL("https://jobicy.com/api/v2/remote-jobs");
      url.searchParams.set("count", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await getJson(url.toString(), { ttlMs: HOUR });
      cacheUsed = cacheUsed && response.fromCache;
      pages += 1;
      const data = asObject(response.data);
      const pageItems = arr(data.jobs);
      for (const raw of pageItems) {
        const mapped = mapJobicy(raw);
        if (mapped) jobs.push(mapped);
      }

      const next = asString(data.nextCursor);
      const hasMore = data.hasMore === true;
      if (!next || !hasMore) break;

      if (cutoff !== undefined && pageItems.length > 0 && pageItems.every((raw) => olderThanCutoff(raw, cutoff))) break;
      cursor = next;
      if (pages === maxPages) partial = true;
    }

    const msg = "Public feed is limited by Jobicy to listings published in the last 7 days. Responses are cached for at least one hour.";
    return result(sourceId, sourceName, jobs, cacheUsed, partial ? `${msg} Page cap reached; some feed pages may remain.` : msg, partial);
  } catch (error) {
    return failed(sourceId, sourceName, error);
  }
}

function mapArbeitnow(raw: unknown, sourceId: string, sourceName: string): JobOpportunity | undefined {
  const j = asObject(raw);
  return makeJob({
    id: j.slug,
    title: j.title,
    company: j.company_name,
    location: j.location,
    explicitRemote: j.remote,
    description: j.description,
    summary: stripHtml(j.description).slice(0, 420),
    publishedAt: j.created_at,
    employmentType: flattenTags(j.job_types).join(", "),
    tags: flattenTags(j.tags, j.job_types),
    jobUrl: j.url,
    applyUrl: j.url,
    sourceName,
    sourceId
  });
}

async function fetchArbeitnow(
  baseUrl: string,
  sourceId: string,
  sourceName: string,
  options: SearchOptions
): Promise<SourceResult> {
  try {
    const jobs: JobOpportunity[] = [];
    const cutoff = cutoffDate(options);
    const maxPages = cutoff !== undefined ? 30 : 8;
    let page = 1;
    let cacheUsed = true;
    let partial = false;
    let reachedCutoff = false;

    while (page <= maxPages) {
      const url = new URL(baseUrl);
      url.searchParams.set("page", String(page));
      const response = await getJson(url.toString(), { ttlMs: HOUR });
      cacheUsed = cacheUsed && response.fromCache;
      const body = asObject(response.data);
      const pageItems = arr(body.data);
      if (pageItems.length === 0) break;

      for (const raw of pageItems) {
        const mapped = mapArbeitnow(raw, sourceId, sourceName);
        if (mapped) jobs.push(mapped);
      }
      if (cutoff !== undefined && pageItems.every((raw) => olderThanCutoff(raw, cutoff))) {
        reachedCutoff = true;
        break;
      }

      const links = asObject(body.links);
      if (!asString(links.next)) break;
      page += 1;
      if (page > maxPages) partial = true;
    }
    const note = "Public no-key job feed; coverage is weighted toward Europe/UK and results are not a global census.";
    const message = partial
      ? `${note} Page cap reached; use a timeframe to narrow the crawl.`
      : reachedCutoff
        ? `${note} Pagination stopped after reaching the selected date cutoff.`
        : note;
    return result(sourceId, sourceName, jobs, cacheUsed, message, partial);
  } catch (error) {
    return failed(sourceId, sourceName, error);
  }
}

function mapRemoteOk(raw: unknown): JobOpportunity | undefined {
  const j = asObject(raw);
  if (!j.position || !j.url) return undefined;
  return makeJob({
    id: j.id ?? j.slug,
    title: j.position,
    company: j.company,
    location: j.location || "Remote",
    explicitRemote: true,
    description: j.description,
    summary: stripHtml(j.description).slice(0, 420),
    publishedAt: j.date ?? j.epoch,
    tags: j.tags,
    salaryMin: j.salary_min,
    salaryMax: j.salary_max,
    salaryCurrency: asString(j.salary_currency),
    jobUrl: j.url,
    applyUrl: j.apply_url ?? j.url,
    sourceName: "Remote OK",
    sourceId: "remoteok"
  });
}

async function fetchRemoteOk(): Promise<SourceResult> {
  try {
    const response = await getJson("https://remoteok.com/api", {
      ttlMs: HOUR,
      headers: { "Accept": "application/json" }
    });
    const rawJobs = arr(response.data).filter((raw) => {
      const j = asObject(raw);
      return Boolean(j.position && j.url);
    });
    const jobs = rawJobs.map(mapRemoteOk).filter((job): job is JobOpportunity => Boolean(job));
    return result(
      "remoteok",
      "Remote OK",
      jobs,
      response.fromCache,
      "Public JSON feed. Preserve Remote OK attribution and link to the original listing."
    );
  } catch (error) {
    return failed("remoteok", "Remote OK", error);
  }
}

function xmlNodeText(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asObject(value);
  return asString(obj["#text"] ?? obj["#cdata-section"]);
}

function mapWwr(raw: unknown): JobOpportunity | undefined {
  const j = asObject(raw);
  const link = xmlNodeText(j.link) || xmlNodeText(j.guid);
  const title = xmlNodeText(j.title);
  const description = xmlNodeText(j["content:encoded"]) || xmlNodeText(j.description);
  if (!title || !link) return undefined;

  const cleanedTitle = title.replace(/\s+/g, " ").trim();
  return makeJob({
    id: xmlNodeText(j.guid) || link,
    title: cleanedTitle,
    company: "See original listing",
    location: "Remote (location eligibility may vary)",
    explicitRemote: true,
    description,
    summary: stripHtml(description).slice(0, 420),
    publishedAt: xmlNodeText(j.pubDate),
    jobUrl: link,
    applyUrl: link,
    sourceName: "We Work Remotely",
    sourceId: "weworkremotely"
  });
}

async function fetchWeWorkRemotely(): Promise<SourceResult> {
  try {
    const response = await getText("https://weworkremotely.com/remote-jobs.rss", {
      ttlMs: HOUR,
      headers: { "Accept": "application/rss+xml, application/xml, text/xml" }
    });
    const parsed = asObject(parser.parse(response.body));
    const rss = asObject(parsed.rss);
    const channel = asObject(rss.channel);
    const items = arr(channel.item);
    const jobs = items.map(mapWwr).filter((job): job is JobOpportunity => Boolean(job));
    return result(
      "weworkremotely",
      "We Work Remotely",
      jobs,
      response.fromCache,
      "Public RSS feed. The feed only exposes recent items; listing availability can change."
    );
  } catch (error) {
    return failed("weworkremotely", "We Work Remotely", error);
  }
}

export async function fetchAllSources(options: SearchOptions): Promise<SourceResult[]> {
  const allowlist = options.enabledSources?.length
    ? new Set(options.enabledSources.map((s) => s.toLowerCase()))
    : process.env.OPPORTUNITY_SOURCES?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).length
      ? new Set(process.env.OPPORTUNITY_SOURCES!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
      : undefined;

  const definitions: Array<{ id: string; run: () => Promise<SourceResult> }> = [
    { id: "jobicy", run: () => fetchJobicy(options) },
    { id: "remoteok", run: () => fetchRemoteOk() },
    { id: "weworkremotely", run: () => fetchWeWorkRemotely() },
    {
      id: "arbeitnow-eu",
      run: () => fetchArbeitnow("https://www.arbeitnow.com/api/job-board-api", "arbeitnow-eu", "Arbeitnow (Europe)", options)
    },
    {
      id: "arbeitnow-uk",
      run: () => fetchArbeitnow("https://www.arbeitnow.co.uk/api/job-board-api", "arbeitnow-uk", "Arbeitnow (UK)", options)
    }
  ];
  const selected = allowlist ? definitions.filter((item) => allowlist.has(item.id)) : definitions;
  const skipped = allowlist
    ? definitions.filter((item) => !allowlist.has(item.id)).map((item): SourceResult => ({
        sourceId: item.id,
        sourceName: item.id,
        status: "skipped",
        jobs: [],
        message: "Not included by OPPORTUNITY_SOURCES allowlist."
      }))
    : [];

  const resolved = await Promise.all(selected.map(async (item) => item.run()));
  return [...resolved, ...skipped];
}