# Opportunity

A Python-first, local/Google Colab-friendly **multi-source job discovery tool**. Enter a phrase such as `data entry` to search by keyword, or omit the phrase to browse latest available listings. It queries several public job feeds (many of them remote-focused) and related job-title variants, normalizes the listings, applies optional publication-date, location, and work-mode filters, merges duplicates, and returns original job/application links plus descriptions, dates, salary fields when published, and source status.

> **Coverage honesty:** no public interface can guarantee every job on every platform. This project queries its configured sources and reports which ones succeeded, failed, used cached results, or hit a pagination cap. It does not claim a source was searched when it was not.

## Hosted website (GitHub Pages)

This branch adds a polished, responsive website in the `site/` folder. It is plain HTML, CSS, and JavaScript, so no frontend build system or paid hosting is required. The browser searches and filters a generated job snapshot; it does not call every provider API directly.

The `Refresh listings & deploy website` GitHub Actions workflow runs the Python tests, collects listings published in the last 14 days, writes `site/data/jobs.json`, validates the website assets, and deploys the static site with GitHub Pages. The workflow is scheduled for every six hours once it runs on the repository's default branch. GitHub schedules run from the default branch; while this is still a feature branch, use Actions → Refresh listings & deploy website → Run workflow to test it manually.

**To enable hosting:** open the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**, then open the **Actions** tab and run **Refresh listings & deploy website** on this branch. Review its log and the deployment URL. The first run can take longer because it queries all configured public feeds. If you later merge this branch into `main`, the same workflow deploys on pushes to `main` and scheduled refreshes can run automatically.

**What this hosting setup does:** keeps a refreshed snapshot of jobs, then lets visitors search and filter that snapshot in the browser. It is not a server-side API and does not update on every keystroke from upstream feeds; new source data arrives when the workflow successfully refreshes the snapshot. Provider limits, publication windows, and failures can affect coverage. The interface keeps original listing and application links so users can verify each lead.


## Run on your PC

Requires Python 3.10+ (Python 3.11+ recommended). The core search uses only the Python standard library—no package installation is required.

```bash
git clone https://github.com/AgentCalmz/opportunity.git
cd opportunity
# Search data-entry jobs posted in the last 5 days
python opportunity.py "data entry" --days 5

# Browse newest available listings without entering a keyword
python opportunity.py

# Browse listings from the last 5 days without a keyword
python opportunity.py --days 5

# Optional: exclude known onsite/hybrid listings and keep remote-only results
python opportunity.py "data entry" --days 5 --remote-only
```

Other useful PC commands (run these from inside the `opportunity` folder):

```bash
# See every available option
python opportunity.py --help

# Browse all recent jobs the feeds currently expose, newest first
python opportunity.py

# Browse only the last 14 days of listings (no keyword needed)
python opportunity.py --days 14

# Find related jobs posted in the last 5 days in Nigeria; keep every work mode
python opportunity.py "customer support" --days 5 --location Nigeria

# Use a fixed start date
python opportunity.py "data entry" --since 2026-10-01

# Search selected sources only; repeat --source for more sources
python opportunity.py "data entry" --days 5 --source himalayas --source jobicy

# Save the full report (including full descriptions) to JSON
python opportunity.py "data entry" --days 5 --out results.json

# Save a no-keyword latest-listings report to JSON
python opportunity.py --out latest_results.json

# Output JSON to a file through shell redirection
python opportunity.py --json > latest_results.json

# Run the unit tests
python -m unittest discover -s tests -v

# Compile-check the main code and tests
python -m py_compile opportunity.py tests/test_opportunity.py

# Pull the newest version from GitHub when updates are published
git pull --ff-only origin main
```

On Windows, use `py` instead of `python` if that is the command that works on your computer (for example, `py opportunity.py --help`). Run `git clone https://github.com/AgentCalmz/opportunity.git` only once; for later updates, first `cd opportunity` and then use `git pull --ff-only origin main`. To use the CLI you need Python 3.10+ and Git installed.

Date filters use the listing's publication date. If the source does not give a parseable date, the listing is excluded when a timeframe is requested and counted in the audit instead of being falsely labelled recent. A date filter cannot retrieve older jobs if a provider does not retain them.

## Use in Google Colab

Open `opportunity_colab.ipynb` in Colab, or run these cells in a new notebook:

```python
!git clone https://github.com/AgentCalmz/opportunity.git
%cd opportunity

from opportunity import search_jobs, print_report

# Latest available listings, no keyword filter, newest first:
report = search_jobs("", days=None, location=None, remote_only=False)  # use location="Nigeria" to restrict eligibility

# For keyword search instead, try:
# report = search_jobs("data entry", days=5, location="Nigeria", remote_only=False)
print_report(report)
```

To inspect results as a table:

```python
import pandas as pd

columns = [
    "title", "company", "location", "published_at",
    "employment_type", "salary_min", "salary_max",
    "salary_currency", "job_url", "apply_url", "source_name"
]
df = pd.DataFrame(report["results"])
display(df[[column for column in columns if column in df.columns]])
```

To save a complete, portable report:

```python
import json

with open("opportunity_results.json", "w", encoding="utf-8") as file:
    json.dump(report, file, ensure_ascii=False, indent=2)

# Optional, in Google Colab:
from google.colab import files
files.download("opportunity_results.json")
```

## Public sources currently connected

| Source | Access | Important limitation |
|---|---|---|
| [Himalayas](https://himalayas.app/api) | Public JSON search endpoint, no key required | Data refreshes daily; rate limits can change and the API may return 429. Retain source attribution and link to the original listing. |
| [Jobicy](https://github.com/Jobicy/remote-jobs-api) | Public JSON API, no key required | Endpoint only provides jobs from the most recent 7 days; up to 200 jobs/page and cursor pagination. |
| [Remote OK](https://remoteok.com/faq) | Public JSON feed, no key required | Feed availability and practical limits can change; retain source attribution and direct job link. |
| [RemoteJobs.org](https://remotejobs.org/developers/api) | Public no-key JSON search API with title/description keyword search and pagination | Published guidance says stay below 200 requests/hour/IP; responses are locally cached for one hour and should carry attribution. |
| [We Work Remotely](https://weworkremotely.com/remote-job-rss-feed) | Public RSS feed | Recent feed, not a complete historical database; attribute the source. Review API terms before redistributing. |
| [Remotive](https://remotive.com/remote-jobs/api) | Public JSON feed, no key required | Cached locally for 24 hours to respect the provider's low-frequency guidance; listings may be delayed. Attribution and source terms apply. |
| [Arbeitnow](https://blog.arbeitnow.com/blog/job-board-api) | Public JSON feed for Europe and UK, no key required | Regional coverage, not a global job feed. Pagination is capped to avoid excessive requests. |

By default, the app includes remote, hybrid, onsite, and unspecified work modes wherever the selected source provides them. Add `--remote-only` on the CLI or pass `remote_only=True` to `search_jobs(...)` to exclude listings explicitly marked onsite or hybrid. Most connected feeds are remote-focused, so disabling the filter does not turn them into general-purpose job boards; it includes non-remote listings only when a source actually supplies them. The app reports per-source health and cache use. A failed source does not prevent successful sources from returning results. Requests are cached locally to lower repeat calls and to help when a provider is temporarily unavailable. Cache files are stored in `.opportunity-cache/` by default and can be moved by setting `OPPORTUNITY_CACHE_DIR`.

## Optional configuration

No API keys are required for the configured public sources. The adapters use modest request budgets, a local cache, and per-source status messages. The default query budget prioritizes trying each related job-title phrase before fetching deeper pages from any one phrase.

Optional environment variables:

- `OPPORTUNITY_CACHE_DIR`: cache directory (default `.opportunity-cache`).
- `OPPORTUNITY_SOURCES`: comma-separated source allowlist, e.g. `himalayas,jobicy,remoteok`.
- `OPPORTUNITY_MAX_PAGES`: pagination cap per phrase for paginated sources (default 10).
- `OPPORTUNITY_REMOTEJOBS_MAX_REQUESTS`: per-search request budget for RemoteJobs.org (default 60, capped at 150 to stay below its published 200/hour/IP guidance).
- `OPPORTUNITY_JOBICY_MAX_REQUESTS`: per-search request budget for Jobicy variants (default 30, capped at 60).
- `OPPORTUNITY_HIMALAYAS_MAX_REQUESTS`: per-search request budget for Himalayas variants (default 20, capped at 50).

Higher request budgets improve coverage but increase traffic. RemoteJobs.org explicitly asks clients to stay below 200 requests per hour per IP; its default request budget is set below that guidance. Responses are cached locally to reduce repeated requests. Do not treat an undocumented provider limit as unlimited.
## Result fields

Each result preserves the original listing URL and includes company, title, location/eligibility, publication date, work mode, normalized summary and full description, tags, employment type/seniority when provided, optional salary fields, application URL, source attribution, and a keyword relevance score with the field that matched. Salary, employment type, seniority, dates, company names, and eligibility are not available for every source; missing fields remain marked unknown rather than being invented.

With an empty query, the tool skips keyword filtering and sorts returned listings by publication date, newest first. Use `days=None` to browse all dates that the configured feeds expose, or `days=5` to limit the results to the last 5 days. "Latest" means latest available from these feeds: source-specific retention periods, caches, pagination limits, and outages can affect coverage.

Search is deliberately **recall-first**: it keeps exact keyword mentions and recognized job-title variants in the main results list and labels each result as a direct/close related match or a broader keyword hit. For `data entry`, variants include data entry clerk/operator/keyer, data encoder, data capture, data transcription/transcriber, records clerk/specialist, document indexing/processing, and data-processing roles. Several related titles are drawn from O*NET's published job-title examples for data-entry work: https://www.onetonline.org/link/summary/43-9021.00. Broader matches can include incidental mentions, so use the match reason and original listing to judge relevance rather than expecting the engine to hide every weak hit. Unknown country eligibility is retained for manual review instead of silently discarded.

When duplicate listings appear on multiple platforms, the tool merges them and retains the alternate source links in `source_links`.

## Adding more platforms

The long-term approach is a provider-adapter architecture. Platforms with public APIs or RSS feeds can usually be added directly. Some APIs are free only with registration/keys, and many major job boards do not expose a global public search endpoint. Greenhouse and Lever, for example, expose public listings per employer's board token; they do not provide a single global search over every employer. Such sources need a separate company/board discovery index, not just another generic API call.

**"Free" does not mean unlimited.** When a provider publishes a limit, it is documented above. When a provider does not publish a limit, this app treats it as undocumented—not unlimited—and uses caching, pagination caps, modest concurrency, retry handling, and source status reporting. Before rehosting or redistributing job data in a public product, review each platform's current terms and attribution requirements.

## Tests

```bash
python -m unittest discover -s tests -v
```
