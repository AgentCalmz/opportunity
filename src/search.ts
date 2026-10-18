import type { JobOpportunity, SearchOptions, SearchReport, SourceResult } from "./types.js";
import { fetchAllSources } from "./providers.js";
import {
  deduplicate,
  formatTimeframe,
  isWithinTimeframe,
  matchesLocation,
  matchesQuery,
  sortNewestFirst
} from "./utils.js";

export async function searchOpportunities(options: SearchOptions): Promise<SearchReport> {
  const startedAt = new Date();
  const sourceResults: SourceResult[] = await fetchAllSources(options);
  const allJobs = sourceResults.flatMap((source) => source.jobs);

  let excludedByDate = 0;
  let excludedUnknownDate = 0;
  let excludedByLocation = 0;
  let excludedNonRemote = 0;
  let candidates: JobOpportunity[] = [];

  for (const job of allJobs) {
    if (!matchesQuery(job, options.query)) continue;

    const timeframe = isWithinTimeframe(job, options);
    if (timeframe === "unknown-date") {
      excludedUnknownDate += 1;
      continue;
    }
    if (!timeframe) {
      excludedByDate += 1;
      continue;
    }

    if (!matchesLocation(job, options.location)) {
      excludedByLocation += 1;
      continue;
    }

    if (options.remoteOnly && job.remoteStatus !== "remote") {
      excludedNonRemote += 1;
      continue;
    }

    candidates.push(job);
  }

  const deduped = deduplicate(candidates);
  const results = sortNewestFirst(deduped.jobs).slice(0, Math.max(1, options.maxResults));
  const completedAt = new Date();

  return {
    query: options.query,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    timeframeLabel: formatTimeframe(options),
    sources: sourceResults,
    results,
    excludedByDate,
    excludedUnknownDate,
    excludedByLocation,
    excludedNonRemote,
    duplicatesRemoved: deduped.removed
  };
}