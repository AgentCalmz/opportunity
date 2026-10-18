# Opportunity

A Python-first, local/Google Colab-friendly **multi-source job discovery tool**. Enter a phrase such as `data entry`; it queries several public remote-job feeds, normalizes the listings, applies an optional publication-date and location filter, merges duplicates, and returns original job/application links plus descriptions, dates, salary fields when published, and source status.

> **Coverage honesty:** no public interface can guarantee every remote job on every platform. This project queries its configured sources and reports which ones succeeded, failed, used cached results, or hit a pagination cap. It does not claim a source was searched when it was not.

## Run on your PC

Requires Python 3.10+ (Python 3.11+ recommended). The core search uses only the Python standard library—no package installation is required.

```bash
git clone https://github.com/AgentCalmz/opportunity.git
cd opportunity
python opportunity.py "data entry" --days 5
```

Other examples:

```bash
# All available dates from the sources' accessible feeds
python opportunity.py "virtual assistant"

# Last 14 days, jobs whose source says they are open in Nigeria or worldwide
python opportunity.py "customer support" --days 14 --location Nigeria

# A fixed start date
python opportunity.py "data entry" --since 2026-10-01

# Search one source only; repeat --source to select several
python opportunity.py "data entry" --days 5 --source himalayas --source jobicy

# Keep the complete results (including full description fields) in JSON
python opportunity.py "data entry" --days 5 --out results.json
python opportunity.py "data entry" --days 5 --json > results.json
```

Date filters use the listing's publication date. If the source does not give a parseable date, the listing is excluded when a timeframe is requested and counted in the audit instead of being falsely labelled recent. A date filter cannot retrieve older jobs if a provider does not retain them.

## Use in Google Colab

Open `opportunity_colab.ipynb` in Colab, or run these cells in a new notebook:

```python
!git clone https://github.com/AgentCalmz/opportunity.git
%cd opportunity

from opportunity import search_jobs, print_report

report = search_jobs("data entry", days=5, location="Nigeria")
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
| [Himalayas](https://himalayas.app/api) | Public JSON search endpoint, no key required | Unkeyed requests share a public allowance. Its free API key has documented higher limits (60 requests/minute, 10,000/day); data refreshes daily. Must retain attribution/link and review API terms. |
| [Jobicy](https://github.com/Jobicy/remote-jobs-api) | Public JSON API, no key required | Endpoint only provides jobs from the most recent 7 days; up to 200 jobs/page and cursor pagination. |
| [Remote OK](https://remoteok.com/faq) | Public JSON feed, no key required | Feed availability and practical limits can change; retain source attribution and direct job link. |
| [We Work Remotely](https://weworkremotely.com/remote-job-rss-feed) | Public RSS feed | Recent feed, not a complete historical database; attribute the source. Review API terms before redistributing. |
| [Remotive](https://remotive.com/remote-jobs/api) | Public JSON feed, no key required | Cached locally for 24 hours to respect the provider's low-frequency guidance; listings may be delayed. Attribution and source terms apply. |
| [Arbeitnow](https://blog.arbeitnow.com/blog/job-board-api) | Public JSON feed for Europe and UK, no key required | Regional coverage, not a global job feed. Pagination is capped to avoid excessive requests. |

The app reports per-source health and cache use. A failed source does not prevent successful sources from returning results. Requests are cached locally to lower repeat calls and to help when a provider is temporarily unavailable. Cache files are stored in `.opportunity-cache/` by default and can be moved by setting `OPPORTUNITY_CACHE_DIR`.

## Optional configuration

No API key is required for the default source set. Himalayas allows an optional free key for its documented higher rate limit.

PowerShell:
```powershell
$env:HIMALAYAS_API_KEY = "your-key"
python opportunity.py "data entry" --days 5
```

macOS/Linux:
```bash
export HIMALAYAS_API_KEY="your-key"
python opportunity.py "data entry" --days 5
```

Colab:
```python
import os
os.environ["HIMALAYAS_API_KEY"] = "your-key"
```

Keep keys private; do not commit them to GitHub or share a notebook with a hard-coded secret.

Optional environment variables:

- `OPPORTUNITY_CACHE_DIR`: cache directory (default `.opportunity-cache`).
- `OPPORTUNITY_SOURCES`: comma-separated source allowlist, e.g. `himalayas,jobicy,remoteok`.
- `OPPORTUNITY_MAX_PAGES`: pagination cap per paginated source (default 10). Higher values may increase request volume; a provider may rate-limit you.

## Result fields

Each strong result preserves the original listing URL, and includes company, title, location/eligibility, publication date, remote status, normalized summary and full description, tags, employment type/seniority when provided, optional salary fields, application URL, source attribution, and a keyword relevance score with the field that matched. Salary, employment type, seniority, dates, company names, and eligibility are not available for every source; missing fields remain marked unknown rather than being invented.

Search relevance is field-weighted: title and structured tags/skills are strongest, summaries are next, and incidental mentions deep in a long description are not treated as ordinary matches. Description-only phrase hits appear separately as lower-confidence review candidates; keyword words scattered across an otherwise unrelated description are excluded. This is a heuristic, not a trained semantic ranking model, so always inspect the listing.

When duplicate listings appear on multiple platforms, the tool merges them and retains the alternate source links in `source_links`.

## Adding more platforms

The long-term approach is a provider-adapter architecture. Platforms with public APIs or RSS feeds can usually be added directly. Some APIs are free only with registration/keys, and many major job boards do not expose a global public search endpoint. Greenhouse and Lever, for example, expose public listings per employer's board token; they do not provide a single global search over every employer. Such sources need a separate company/board discovery index, not just another generic API call.

**"Free" does not mean unlimited.** When a provider publishes a limit, it is documented above. When a provider does not publish a limit, this app treats it as undocumented—not unlimited—and uses caching, pagination caps, modest concurrency, retry handling, and source status reporting. Before rehosting or redistributing job data in a public product, review each platform's current terms and attribution requirements.

## Tests

```bash
python -m unittest discover -s tests -v
```
