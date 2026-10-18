import { writeFile } from "node:fs/promises";
import type { SearchOptions, SearchReport } from "./types.js";
import { searchOpportunities } from "./search.js";

function usage(): void {
  console.log(`
Opportunity — multi-source opportunity search

Usage:
  npm run search -- "data entry" [options]

Options:
  --days N             Only include listings published within the last N days
  --since YYYY-MM-DD   Only include listings published on/after this date
  --location REGION    Prefer jobs eligible for a country/region (e.g. Nigeria)
  --include-onsite     Include listings explicitly marked onsite or hybrid
  --max-results N      Limit displayed results (default: 100)
  --source ID          Run only this source; repeatable
  --json               Print the full report as JSON
  --out FILE           Write the full report to a JSON file
  --help               Show this help

Sources currently enabled by default:
  jobicy, remoteok, weworkremotely, arbeitnow-eu, arbeitnow-uk

Examples:
  npm run search -- "data entry" --days 5
  npm run search -- "virtual assistant" --days 14 --location Nigeria
  npm run search -- "data entry" --since 2026-10-01 --max-results 250
  npm run search -- "customer support" --source remoteok --json
`);
}

function parseArgs(args: string[]): { options?: SearchOptions; json: boolean; out?: string; help: boolean } {
  let query = "";
  let days: number | undefined;
  let since: string | undefined;
  let location: string | undefined;
  let remoteOnly = true;
  let maxResults = 100;
  let json = false;
  let out: string | undefined;
  const enabledSources: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === "--help" || arg === "-h") return { json, help: true };
    if (arg === "--days") {
      if (!next || !/^\d+$/.test(next) || Number(next) < 1 || Number(next) > 3650) {
        throw new Error("--days requires an integer between 1 and 3650.");
      }
      days = Number(next); i += 1; continue;
    }
    if (arg === "--since") {
      if (!next || Number.isNaN(Date.parse(next))) throw new Error("--since requires a valid date, such as 2026-10-01.");
      since = new Date(next).toISOString().slice(0, 10); i += 1; continue;
    }
    if (arg === "--location") {
      if (!next) throw new Error("--location requires a value.");
      location = next; i += 1; continue;
    }
    if (arg === "--include-onsite") { remoteOnly = false; continue; }
    if (arg === "--max-results") {
      if (!next || !/^\d+$/.test(next) || Number(next) < 1 || Number(next) > 5000) {
        throw new Error("--max-results requires an integer between 1 and 5000.");
      }
      maxResults = Number(next); i += 1; continue;
    }
    if (arg === "--source") {
      if (!next) throw new Error("--source requires a source ID.");
      enabledSources.push(next.toLowerCase()); i += 1; continue;
    }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--out") {
      if (!next) throw new Error("--out requires a file path.");
      out = next; i += 1; continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    if (query) query += ` ${arg}`;
    else query = arg;
  }

  if (days !== undefined && since !== undefined) throw new Error("Use either --days or --since, not both.");
  if (!query.trim()) throw new Error('A search keyword is required. Example: npm run search -- "data entry" --days 5');

  const options: SearchOptions = {
    query: query.trim(),
    remoteOnly,
    maxResults,
    ...(days !== undefined ? { days } : {}),
    ...(since ? { since } : {}),
    ...(location ? { location } : {}),
    ...(enabledSources.length ? { enabledSources } : {})
  };
  return { options, json, ...(out ? { out } : {}), help: false };
}

function displayReport(report: SearchReport): void {
  console.log(`\nOPPORTUNITY SEARCH: "${report.query}"`);
  console.log(`Timeframe: ${report.timeframeLabel}`);
  console.log(`Remote-only: yes\n`);

  console.log("SOURCE STATUS");
  for (const source of report.sources) {
    const cache = source.cacheUsed ? " [cache]" : "";
    console.log(`- ${source.sourceName}: ${source.status}; ${source.jobs.length} raw jobs${cache}`);
    if (source.message) console.log(`  ${source.message}`);
    if (source.error) console.log(`  Error: ${source.error}`);
  }

  console.log(`\nMATCHES: ${report.results.length}`);
  if (report.results.length === 0) console.log("No listings matched every selected filter in the returned source data.");
  report.results.forEach((job, index) => {
    console.log(`\n${index + 1}. ${job.title} — ${job.company}`);
    console.log(`   Location: ${job.location} | Type: ${job.employmentType ?? "Not stated"} | Remote: ${job.remoteStatus}`);
    console.log(`   Published: ${job.publishedAt ?? "Date not provided"}`);
    if (job.salaryMin !== undefined || job.salaryMax !== undefined) {
      const low = job.salaryMin?.toLocaleString("en-US") ?? "?";
      const high = job.salaryMax?.toLocaleString("en-US") ?? "?";
      console.log(`   Salary: ${low}–${high} ${job.salaryCurrency ?? ""} ${job.salaryPeriod ?? ""}`.trimEnd());
    } else {
      console.log("   Salary: Not disclosed by source");
    }
    if (job.tags.length) console.log(`   Tags: ${job.tags.join(", ")}`);
    if (job.summary) console.log(`   Summary: ${job.summary.replace(/\s+/g, " ").slice(0, 320)}`);
    console.log(`   Job link: ${job.jobUrl}`);
    if (job.applyUrl && job.applyUrl !== job.jobUrl) console.log(`   Apply: ${job.applyUrl}`);
    console.log(`   Source: ${job.sourceName}`);
  });

  console.log("\nSEARCH AUDIT");
  console.log(`- Duplicate matches removed: ${report.duplicatesRemoved}`);
  console.log(`- Excluded by timeframe: ${report.excludedByDate}`);
  console.log(`- Excluded because publication date was unknown: ${report.excludedUnknownDate}`);
  console.log(`- Excluded by location: ${report.excludedByLocation}`);
  console.log(`- Excluded because not explicitly remote: ${report.excludedNonRemote}`);
  console.log("- A listing is not guaranteed to remain open; open the original listing before applying.");
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) { usage(); return; }
    const options = parsed.options!;
    console.log(`Searching public sources for "${options.query}"...`);
    const report = await searchOpportunities(options);

    if (parsed.out) {
      await writeFile(parsed.out, JSON.stringify(report, null, 2), "utf8");
      console.log(`Full report written to ${parsed.out}`);
    }
    if (parsed.json) console.log(JSON.stringify(report, null, 2));
    else displayReport(report);

    if (!report.sources.some((source) => source.status === "ok" || source.status === "partial")) {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 1;
  }
}

await main();