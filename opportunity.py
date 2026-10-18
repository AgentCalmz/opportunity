"""Opportunity: local and Colab-friendly multi-source remote-job search.

Only Python's standard library is required. Sources may change schemas, availability,
terms, and rate limits; the report therefore includes a status for each adapter.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import email.utils
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

VERSION = "0.1.0"
USER_AGENT = (
    "Opportunity/0.1 (personal job discovery; "
    "https://github.com/AgentCalmz/opportunity)"
)
HOUR = 60 * 60
DAY = 24 * HOUR
MAX_SOURCE_PAGES = max(1, int(os.getenv("OPPORTUNITY_MAX_PAGES", "10")))

SOURCE_NOTES = {
    "himalayas": (
        "Public search API; data refreshes about daily. Attribute Himalayas and link "
        "to the original listing. A free API key raises the documented allowance."
    ),
    "jobicy": (
        "No-key public API. Its feed contains jobs published within the last 7 days; "
        "it cannot provide older listings through this endpoint."
    ),
    "remoteok": (
        "Public JSON feed. Preserve Remote OK attribution and link to the original job."
    ),
    "remotejobsorg": (
        "Public no-key JSON search API. Search titles and descriptions directly, cache "
        "responses, stay within published request guidance, and keep attribution."
    ),
    "weworkremotely": (
        "Public RSS feed. Attribute We Work Remotely and link to the original job. "
        "Use for personal discovery; review source terms before redistributing data."
    ),
    "remotive": (
        "Public feed is cached for 24 hours to respect Remotive's guidance to fetch "
        "only a few times per day. Listings may be delayed by 24 hours. Attribute "
        "Remotive and verify its terms before any public redistribution."
    ),
    "arbeitnow-eu": (
        "No-key public feed, strongest coverage in Europe. It is not a global census."
    ),
    "arbeitnow-uk": (
        "No-key public UK feed. It is not a global census."
    ),
}


# ---------------------------------------------------------------------------
# General utilities
# ---------------------------------------------------------------------------

def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_datetime(value: Any) -> datetime | None:
    """Parse Unix timestamps, ISO dates, and RFC email/RSS publication dates."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            seconds = float(value)
            if seconds > 10_000_000_000:
                seconds /= 1000.0
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"\d{10,13}", text):
        try:
            return parse_datetime(int(text))
        except (ValueError, OverflowError):
            return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        pass
    try:
        parsed = email.utils.parsedate_to_datetime(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def strip_html(value: Any) -> str:
    """Convert HTML-ish job descriptions to readable, plain text."""
    text = str(value or "")
    text = re.sub(r"(?is)<(script|style)\b[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<\s*br\s*/?\s*>", "\n", text)
    text = re.sub(r"(?i)</\s*(p|div|li|h[1-6]|section|tr)\s*>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text).replace("\xa0", " ")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_text(value: Any) -> str:
    text = str(value or "").casefold()
    text = html.unescape(text)
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def _first(*values: Any, default: Any = None) -> Any:
    for value in values:
        if value is not None and value != "":
            return value
    return default


def _string_list(value: Any) -> list[str]:
    items = []
    for item in _as_list(value):
        if isinstance(item, dict):
            item = _first(item.get("name"), item.get("label"), item.get("title"), default="")
        if item is not None and str(item).strip():
            items.append(str(item).strip())
    return list(dict.fromkeys(items))


def _url_key(url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(url.strip())
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        query = [
            (k, v) for k, v in query
            if not re.match(r"^(utm_.+|ref|source|campaign|gh_src)$", k, re.I)
        ]
        normalized_query = urllib.parse.urlencode(sorted(query))
        return urllib.parse.urlunsplit((
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path.rstrip("/"),
            normalized_query,
            "",
        )).lower()
    except Exception:
        return url.strip().rstrip("/").lower()


def _cache_dir() -> Path:
    configured = os.getenv("OPPORTUNITY_CACHE_DIR", "").strip()
    return Path(configured or ".opportunity-cache").expanduser()


def _cache_path(url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    return _cache_dir() / f"{digest}.json"


def _read_cache(path: Path) -> dict[str, Any] | None:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(obj, dict) and isinstance(obj.get("body"), str):
            return obj
    except (OSError, ValueError, TypeError):
        pass
    return None


def _retry_delay(headers: Any, attempt: int) -> float:
    retry_after = None
    try:
        retry_after = headers.get("Retry-After")
    except Exception:
        pass
    if retry_after:
        try:
            return min(8.0, max(0.0, float(retry_after)))
        except ValueError:
            parsed = parse_datetime(retry_after)
            if parsed:
                return min(8.0, max(0.0, (parsed - _now_utc()).total_seconds()))
    return min(0.5 * (2 ** attempt), 4.0)


def _request_text(
    url: str,
    *,
    ttl_seconds: int = HOUR,
    headers: dict[str, str] | None = None,
    timeout: int = 25,
) -> tuple[str, dict[str, Any]]:
    """Fetch with small retries, a disk cache, and stale-cache fallback."""
    path = _cache_path(url)
    cache = _read_cache(path)
    now_epoch = time.time()
    if cache and now_epoch - float(cache.get("cached_at", 0)) <= ttl_seconds:
        return str(cache["body"]), {
            "cache_used": True,
            "cache_stale": False,
            "cache_age_seconds": max(0, int(now_epoch - float(cache.get("cached_at", now_epoch)))),
        }

    last_error: Exception | None = None
    for attempt in range(3):
        request_headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, application/rss+xml, application/xml, text/xml, */*",
        }
        request_headers.update(headers or {})
        request = urllib.request.Request(url, headers=request_headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8", errors="replace")
            record = {"cached_at": time.time(), "body": body, "url": url}
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            except OSError:
                # Caching is optional. A read-only folder should not break the search.
                pass
            return body, {"cache_used": False, "cache_stale": False, "cache_age_seconds": 0}
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                delay = _retry_delay(exc.headers, attempt)
                # Don't allow unusually long Retry-After values to stall an interactive search.
                if delay <= 8:
                    time.sleep(delay)
                    continue
            break
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc if isinstance(exc, Exception) else Exception(str(exc))
            if attempt < 2:
                time.sleep(0.35 * (attempt + 1))
                continue
            break

    if cache:
        age = max(0, int(time.time() - float(cache.get("cached_at", time.time()))))
        message = f"Source unavailable ({last_error}); used cached data from {age // 3600}h ago."
        return str(cache["body"]), {
            "cache_used": True,
            "cache_stale": True,
            "cache_age_seconds": age,
            "cache_warning": message,
        }
    if last_error:
        raise RuntimeError(f"{urllib.parse.urlsplit(url).netloc}: {last_error}") from last_error
    raise RuntimeError(f"{urllib.parse.urlsplit(url).netloc}: request failed")


def _request_json(
    url: str,
    *,
    ttl_seconds: int = HOUR,
    headers: dict[str, str] | None = None,
) -> tuple[dict[str, Any] | list[Any], dict[str, Any]]:
    text, meta = _request_text(url, ttl_seconds=ttl_seconds, headers=headers)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from {urllib.parse.urlsplit(url).netloc}") from exc
    if not isinstance(data, (dict, list)):
        raise RuntimeError(f"Unexpected JSON response from {urllib.parse.urlsplit(url).netloc}")
    return data, meta


def _make_job(
    *,
    source_id: str,
    source_name: str,
    title: Any,
    company: Any,
    url: Any,
    description: Any = "",
    summary: Any = "",
    published_at: Any = None,
    location: Any = "Remote",
    remote_status: str = "remote",
    employment_type: Any = None,
    seniority: Any = None,
    tags: Any = None,
    salary_min: Any = None,
    salary_max: Any = None,
    salary_currency: Any = None,
    salary_period: Any = None,
    apply_url: Any = None,
) -> dict[str, Any] | None:
    title_text = strip_html(title)
    job_url = str(url or "").strip()
    if not title_text or not job_url or not job_url.startswith(("https://", "http://")):
        return None
    company_text = strip_html(company) or "Company not listed"
    description_text = strip_html(description)
    # The summary is a short excerpt, never the full description; relevance ranking relies on this distinction.
    summary_text = (strip_html(summary) or description_text[:500])[:500]
    date_value = parse_datetime(published_at)
    job: dict[str, Any] = {
        "title": title_text,
        "company": company_text,
        "location": strip_html(location) or "Location not specified",
        "remote_status": remote_status,
        "description": description_text,
        "summary": summary_text,
        "published_at": _iso(date_value),
        "employment_type": ", ".join(_string_list(employment_type)) or (strip_html(employment_type) or None),
        "seniority": ", ".join(_string_list(seniority)) or (strip_html(seniority) or None),
        "tags": _string_list(tags),
        "salary_min": _optional_number(salary_min),
        "salary_max": _optional_number(salary_max),
        "salary_currency": strip_html(salary_currency) or None,
        "salary_period": strip_html(salary_period) or None,
        "job_url": job_url,
        "apply_url": str(apply_url or "").strip() or job_url,
        "source_name": source_name,
        "source_id": source_id,
        "source_links": [{"source": source_name, "url": job_url}],
    }
    return job


def _optional_number(value: Any) -> float | int | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
        if number < 0:
            return None
        return int(number) if number.is_integer() else number
    except (ValueError, TypeError, OverflowError):
        return None


def _append_location_restrictions(restrictions: Any) -> str:
    names: list[str] = []
    for item in _as_list(restrictions):
        if isinstance(item, dict):
            value = _first(item.get("name"), item.get("alpha2"), item.get("slug"))
            if value:
                names.append(str(value))
        elif item:
            names.append(str(item))
    return ", ".join(dict.fromkeys(names))


def _result(
    source_id: str,
    source_name: str,
    jobs: list[dict[str, Any]],
    meta: dict[str, Any] | None = None,
    *,
    status: str = "ok",
    message: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    meta = meta or {}
    result = {
        "source_id": source_id,
        "source_name": source_name,
        "status": status,
        "raw_jobs_count": len(jobs),
        "jobs": jobs,
        "cache_used": bool(meta.get("cache_used", False)),
        "cache_stale": bool(meta.get("cache_stale", False)),
        "fetched_at": _iso(_now_utc()),
        "note": SOURCE_NOTES.get(source_id, ""),
    }
    if meta.get("cache_warning"):
        result["cache_warning"] = meta["cache_warning"]
    if message:
        result["message"] = message
    if error:
        result["error"] = error
    return result


def _source_error(source_id: str, source_name: str, exc: Exception) -> dict[str, Any]:
    return _result(source_id, source_name, [], status="error", error=str(exc))


def _jobicy_job(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    job_url = _first(raw.get("url"), raw.get("jobUrl"))
    return _make_job(
        source_id="jobicy",
        source_name="Jobicy",
        title=_first(raw.get("jobTitle"), raw.get("title")),
        company=_first(raw.get("companyName"), raw.get("company")),
        url=job_url,
        description=raw.get("jobDescription"),
        summary=raw.get("jobExcerpt"),
        published_at=_first(raw.get("pubDate"), raw.get("date")),
        location=_first(raw.get("jobGeo"), default="Remote / see listing"),
        remote_status="remote",
        employment_type=raw.get("jobType"),
        seniority=raw.get("jobLevel"),
        tags=[*_string_list(raw.get("jobIndustry")), *_string_list(raw.get("jobType"))],
        salary_min=raw.get("salaryMin"),
        salary_max=raw.get("salaryMax"),
        salary_currency=raw.get("salaryCurrency"),
        salary_period=raw.get("salaryPeriod"),
        apply_url=job_url,
    )


def _fetch_jobicy(query: str, days: int | None) -> dict[str, Any]:
    source_id, source_name = "jobicy", "Jobicy"
    try:
        jobs: list[dict[str, Any]] = []
        cursor: str | None = None
        meta_all = {"cache_used": True, "cache_stale": False}
        pages = 0
        while pages < min(MAX_SOURCE_PAGES, 10):
            params: dict[str, str] = {"count": "200"}
            clean_query = query.strip()
            if len(clean_query) >= 3:
                params["tag"] = clean_query[:50]
            if cursor:
                params["cursor"] = cursor
            url = "https://jobicy.com/api/v2/remote-jobs?" + urllib.parse.urlencode(params)
            data, meta = _request_json(url, ttl_seconds=HOUR)
            pages += 1
            meta_all["cache_used"] = bool(meta_all["cache_used"] and meta.get("cache_used"))
            meta_all["cache_stale"] = bool(meta_all["cache_stale"] or meta.get("cache_stale"))
            raw_jobs = data.get("jobs", []) if isinstance(data, dict) else []
            if not isinstance(raw_jobs, list):
                raw_jobs = []
            page_jobs = [job for raw in raw_jobs if (job := _jobicy_job(raw))]
            jobs.extend(page_jobs)
            if days is not None and page_jobs:
                cutoff = _now_utc() - timedelta(days=days)
                dated = [parse_datetime(raw.get("pubDate")) for raw in raw_jobs if isinstance(raw, dict)]
                if dated and all(dt is not None and dt < cutoff for dt in dated):
                    break
            next_cursor = data.get("nextCursor") if isinstance(data, dict) else None
            has_more = bool(data.get("hasMore")) if isinstance(data, dict) else False
            if not next_cursor or not has_more:
                break
            cursor = str(next_cursor)
        status = "partial" if pages >= min(MAX_SOURCE_PAGES, 10) and cursor else "ok"
        message = f"Read {pages} page(s) from the last-7-days feed."
        return _result(source_id, source_name, jobs, meta_all, status=status, message=message)
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


def _himalayas_job(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    restrictions = _append_location_restrictions(raw.get("locationRestrictions"))
    if restrictions:
        location = restrictions
    else:
        location = "Worldwide / no country restriction listed"
    timezone_restrictions = _string_list(raw.get("timezoneRestrictions"))
    if timezone_restrictions:
        location += " | Time zones: " + ", ".join(timezone_restrictions)
    apply_link = raw.get("applicationLink")
    guid = str(raw.get("guid") or "").strip()
    # Himalayas commonly returns guid as a job URL; otherwise create a link to its search page.
    job_url = guid if guid.startswith(("https://", "http://")) else str(apply_link or "")
    return _make_job(
        source_id="himalayas",
        source_name="Himalayas",
        title=raw.get("title"),
        company=raw.get("companyName"),
        url=job_url,
        description=raw.get("description"),
        summary=raw.get("excerpt"),
        published_at=raw.get("pubDate"),
        location=location,
        remote_status="remote",
        employment_type=raw.get("employmentType"),
        seniority=raw.get("seniority"),
        tags=[*_string_list(raw.get("categories")), *_string_list(raw.get("parentCategories"))],
        salary_min=raw.get("minSalary"),
        salary_max=raw.get("maxSalary"),
        salary_currency=raw.get("currency"),
        salary_period=raw.get("salaryPeriod"),
        apply_url=apply_link or job_url,
    )


def _fetch_himalayas(query: str, days: int | None = None) -> dict[str, Any]:
    source_id, source_name = "himalayas", "Himalayas"
    try:
        jobs: list[dict[str, Any]] = []
        cache_used = True
        stale = False
        pages = 0
        partial = False
        for page in range(1, MAX_SOURCE_PAGES + 1):
            params = {"q": query, "sort": "recent", "page": str(page)}
            url = "https://himalayas.app/jobs/api/search?" + urllib.parse.urlencode(params)
            headers: dict[str, str] = {}
            api_key = os.getenv("HIMALAYAS_API_KEY", "").strip()
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            data, meta = _request_json(url, ttl_seconds=DAY, headers=headers)
            cache_used = cache_used and bool(meta.get("cache_used"))
            stale = stale or bool(meta.get("cache_stale"))
            pages += 1
            raw_jobs = data.get("jobs", []) if isinstance(data, dict) else []
            if not isinstance(raw_jobs, list) or not raw_jobs:
                break
            jobs.extend(job for raw in raw_jobs if (job := _himalayas_job(raw)))
            if len(raw_jobs) < 20:
                break
            if page == MAX_SOURCE_PAGES:
                partial = True
        meta_summary = {"cache_used": cache_used, "cache_stale": stale}
        message = f"Read {pages} page(s) from Himalayas search."
        if partial:
            message += f" Page cap ({MAX_SOURCE_PAGES}) reached; results may be incomplete."
        return _result(
            source_id, source_name, jobs, meta_summary,
            status="partial" if partial else "ok", message=message
        )
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


def _remoteok_job(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw.get("position"):
        return None
    job_url = _first(raw.get("url"), raw.get("apply_url"))
    tags = _string_list(raw.get("tags"))
    return _make_job(
        source_id="remoteok",
        source_name="Remote OK",
        title=raw.get("position"),
        company=raw.get("company"),
        url=job_url,
        description=raw.get("description"),
        summary=raw.get("description"),
        published_at=_first(raw.get("date"), raw.get("epoch")),
        location=raw.get("location") or "Remote / see listing",
        remote_status="remote",
        tags=tags,
        salary_min=raw.get("salary_min"),
        salary_max=raw.get("salary_max"),
        salary_currency=raw.get("salary_currency"),
        apply_url=raw.get("apply_url") or job_url,
    )


def _fetch_remoteok(query: str, days: int | None) -> dict[str, Any]:
    source_id, source_name = "remoteok", "Remote OK"
    try:
        data, meta = _request_json("https://remoteok.com/api", ttl_seconds=HOUR)
        rows = data if isinstance(data, list) else data.get("jobs", [])
        jobs = [job for raw in rows if (job := _remoteok_job(raw))]
        return _result(source_id, source_name, jobs, meta)
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


def _xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return " ".join("".join(node.itertext()).split())


def _wwr_job(item: ET.Element) -> dict[str, Any] | None:
    title_text = _xml_text(item.find("title"))
    link = _xml_text(item.find("link"))
    description = _xml_text(item.find("description"))
    pub_date = _xml_text(item.find("pubDate"))
    if not title_text or not link:
        return None
    company = "See original listing"
    title = title_text
    # RSS titles often look like "Company: Job Title" or "Job Title at Company".
    if ":" in title_text:
        maybe_company, maybe_title = title_text.split(":", 1)
        if maybe_company.strip() and maybe_title.strip():
            company, title = maybe_company.strip(), maybe_title.strip()
    elif re.search(r"\s+at\s+", title_text, flags=re.I):
        title, company = re.split(r"\s+at\s+", title_text, maxsplit=1, flags=re.I)
    return _make_job(
        source_id="weworkremotely",
        source_name="We Work Remotely",
        title=title,
        company=company,
        url=link,
        description=description,
        summary=description,
        published_at=pub_date,
        location="Remote / country eligibility may vary",
        remote_status="remote",
        apply_url=link,
    )


def _fetch_wwr(query: str, days: int | None) -> dict[str, Any]:
    source_id, source_name = "weworkremotely", "We Work Remotely"
    try:
        body, meta = _request_text(
            "https://weworkremotely.com/remote-jobs.rss",
            ttl_seconds=HOUR,
            headers={"Accept": "application/rss+xml, application/xml, text/xml"},
        )
        root = ET.fromstring(body)
        items = root.findall(".//item")
        jobs = [job for item in items if (job := _wwr_job(item))]
        return _result(source_id, source_name, jobs, meta)
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


def _remotive_job(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    job_url = raw.get("url")
    return _make_job(
        source_id="remotive",
        source_name="Remotive",
        title=raw.get("title"),
        company=raw.get("company_name"),
        url=job_url,
        description=raw.get("description"),
        summary=raw.get("description"),
        published_at=raw.get("publication_date"),
        location=raw.get("candidate_required_location") or "Remote / see listing",
        remote_status="remote",
        employment_type=raw.get("job_type"),
        tags=[*_string_list(raw.get("category")), *_string_list(raw.get("tags"))],
        salary_currency=None,
        apply_url=job_url,
    )


def _fetch_remotive(query: str, days: int | None) -> dict[str, Any]:
    source_id, source_name = "remotive", "Remotive"
    try:
        # Fetch the common full feed once per day; query filtering happens locally.
        data, meta = _request_json("https://remotive.com/api/remote-jobs", ttl_seconds=DAY)
        rows = data.get("jobs", []) if isinstance(data, dict) else []
        jobs = [job for raw in rows if (job := _remotive_job(raw))]
        return _result(source_id, source_name, jobs, meta)
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


def _remotejobs_job(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    company = raw.get("company")
    company_name = company.get("name") if isinstance(company, dict) else company
    category = raw.get("category")
    category_name = category.get("name") if isinstance(category, dict) else category
    tags = [category_name] if category_name else []
    if isinstance(category, dict) and category.get("slug"):
        tags.append(str(category["slug"]))

    job_url = raw.get("url")
    location = str(raw.get("location") or "Remote / eligibility not specified")
    location_info = raw.get("location_normalization")
    if isinstance(location_info, dict):
        scope = str(location_info.get("scope") or "").casefold()
        allowed = location_info.get("allowed_countries") or []
        country_names = {
            "NG": "Nigeria", "US": "United States", "GB": "United Kingdom",
            "CA": "Canada", "AU": "Australia", "IN": "India", "ZA": "South Africa",
            "KE": "Kenya", "GH": "Ghana", "PH": "Philippines", "DE": "Germany",
            "FR": "France", "IE": "Ireland", "NZ": "New Zealand", "BR": "Brazil",
            "MX": "Mexico", "PT": "Portugal", "ES": "Spain", "NL": "Netherlands",
        }
        if scope == "worldwide":
            location += " | Worldwide"
        elif isinstance(allowed, list) and allowed:
            readable = [country_names.get(str(code).upper(), str(code)) for code in allowed]
            location += " | Eligible countries: " + ", ".join(readable)
        regions = location_info.get("regions") or []
        if isinstance(regions, list) and regions:
            location += " | Regions: " + ", ".join(str(region) for region in regions)

    job = _make_job(
        source_id="remotejobsorg", source_name="RemoteJobs.org",
        title=raw.get("title"), company=company_name, url=job_url,
        description=raw.get("description"), summary=raw.get("description"),
        published_at=raw.get("posted_at"), location=location,
        remote_status="remote", employment_type=raw.get("type"),
        tags=tags, salary_min=raw.get("salary_min"), salary_max=raw.get("salary_max"),
        salary_currency=raw.get("salary_currency"), salary_period=raw.get("salary_period"),
        apply_url=raw.get("apply_url") or job_url,
    )
    if job:
        job["salary_text"] = raw.get("salary_text")
        job["company_website"] = company.get("website") if isinstance(company, dict) else None
        job["company_profile_url"] = company.get("url") if isinstance(company, dict) else None
        job["category"] = category_name
        job["direct_apply"] = raw.get("direct_apply")
    return job


def _fetch_remotejobsorg(query: str, days: int | None) -> dict[str, Any]:
    source_id, source_name = "remotejobsorg", "RemoteJobs.org"
    try:
        jobs: list[dict[str, Any]] = []
        cache_used = True
        stale = False
        pages_read = 0
        partial = False
        variants = _query_variants(query)
        cutoff = _now_utc() - timedelta(days=days) if days is not None else None
        page_limit = min(MAX_SOURCE_PAGES, 2)

        for variant in variants:
            offset = 0
            for page_index in range(page_limit):
                params = urllib.parse.urlencode({"q": variant, "limit": 50, "offset": offset})
                url = "https://remotejobs.org/api/v1/jobs?" + params
                data, meta = _request_json(url, ttl_seconds=HOUR)
                cache_used = cache_used and bool(meta.get("cache_used"))
                stale = stale or bool(meta.get("cache_stale"))
                rows = data.get("data", []) if isinstance(data, dict) else []
                if not isinstance(rows, list) or not rows:
                    break
                pages_read += 1
                for raw in rows:
                    job = _remotejobs_job(raw)
                    if job:
                        jobs.append(job)

                dates = [
                    parse_datetime(raw.get("posted_at"))
                    for raw in rows if isinstance(raw, dict)
                ]
                if cutoff and dates and all(posted is not None and posted < cutoff for posted in dates):
                    break
                pagination = data.get("pagination", {}) if isinstance(data, dict) else {}
                if not isinstance(pagination, dict) or not pagination.get("has_more"):
                    break
                offset += len(rows)
                if page_index == page_limit - 1:
                    partial = True

        meta_summary = {"cache_used": cache_used, "cache_stale": stale}
        message = f"Queried {len(variants)} keyword phrase(s) across {pages_read} page(s)."
        if partial:
            message += f" Page cap ({page_limit} pages per phrase) reached; increase OPPORTUNITY_MAX_PAGES cautiously if needed."
        return _result(
            source_id, source_name, jobs, meta_summary,
            status="partial" if partial else "ok", message=message
        )
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


def _arbeitnow_job(raw: Any, source_id: str, source_name: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    remote_value = raw.get("remote")
    remote_status = "remote" if remote_value is True or str(remote_value).lower() == "true" else "onsite"
    job_url = raw.get("url")
    return _make_job(
        source_id=source_id,
        source_name=source_name,
        title=raw.get("title"),
        company=raw.get("company_name"),
        url=job_url,
        description=raw.get("description"),
        summary=raw.get("description"),
        published_at=raw.get("created_at"),
        location=raw.get("location") or "Location not specified",
        remote_status=remote_status,
        employment_type=raw.get("job_types"),
        tags=[*_string_list(raw.get("tags")), *_string_list(raw.get("job_types"))],
        apply_url=job_url,
    )


def _fetch_arbeitnow(base_url: str, source_id: str, source_name: str, days: int | None) -> dict[str, Any]:
    try:
        jobs: list[dict[str, Any]] = []
        cache_used = True
        stale = False
        partial = False
        reached_cutoff = False
        max_pages = MAX_SOURCE_PAGES
        cutoff = _now_utc() - timedelta(days=days) if days is not None else None
        pages = 0
        for page in range(1, max_pages + 1):
            url = base_url + "?" + urllib.parse.urlencode({"page": page})
            data, meta = _request_json(url, ttl_seconds=HOUR)
            cache_used = cache_used and bool(meta.get("cache_used"))
            stale = stale or bool(meta.get("cache_stale"))
            rows = data.get("data", []) if isinstance(data, dict) else []
            if not isinstance(rows, list) or not rows:
                break
            pages += 1
            jobs.extend(
                job for raw in rows
                if (job := _arbeitnow_job(raw, source_id, source_name))
            )
            dates = [
                parse_datetime(raw.get("created_at"))
                for raw in rows if isinstance(raw, dict)
            ]
            if cutoff and dates and all(dt is not None and dt < cutoff for dt in dates):
                reached_cutoff = True
                break
            links = data.get("links", {}) if isinstance(data, dict) else {}
            if not isinstance(links, dict) or not links.get("next"):
                break
            if page == max_pages:
                partial = True
        meta_summary = {"cache_used": cache_used, "cache_stale": stale}
        message = f"Read {pages} page(s)."
        if reached_cutoff:
            message += " Pagination stopped after reaching the selected date cutoff."
        if partial:
            message += f" Page cap ({max_pages}) reached; narrow the timeframe or increase OPPORTUNITY_MAX_PAGES."
        return _result(
            source_id, source_name, jobs, meta_summary,
            status="partial" if partial else "ok", message=message
        )
    except Exception as exc:
        return _source_error(source_id, source_name, exc)


SOURCE_RUNNERS: dict[str, tuple[str, Callable[..., dict[str, Any]]]] = {
    "himalayas": ("Himalayas", _fetch_himalayas),
    "jobicy": ("Jobicy", _fetch_jobicy),
    "remoteok": ("Remote OK", _fetch_remoteok),
    "remotejobsorg": ("RemoteJobs.org", _fetch_remotejobsorg),
    "weworkremotely": ("We Work Remotely", _fetch_wwr),
    "remotive": ("Remotive", _fetch_remotive),
    "arbeitnow-eu": ("Arbeitnow (Europe)", lambda query, days: _fetch_arbeitnow(
        "https://www.arbeitnow.com/api/job-board-api", "arbeitnow-eu", "Arbeitnow (Europe)", days
    )),
    "arbeitnow-uk": ("Arbeitnow (UK)", lambda query, days: _fetch_arbeitnow(
        "https://www.arbeitnow.co.uk/api/job-board-api", "arbeitnow-uk", "Arbeitnow (UK)", days
    )),
}


# ---------------------------------------------------------------------------
# Search, timeframe filters, deduplication, and report generation
# ---------------------------------------------------------------------------

def _query_variants(query: str) -> list[str]:
    """Generate role-title variants to improve recall without replacing the original query."""
    normalized = normalize_text(query)
    if normalized in {
        "data entry", "data entry jobs", "data entry job", "data entry clerk",
        "data entry operator", "data entry specialist", "data entry keyer",
    }:
        # These are common adjacent titles for data-entry/keying work. Results are labeled
        # by how they match; the search does not silently discard related postings.
        return [
            "data entry",
            "data entry clerk",
            "data entry specialist",
            "data entry operator",
            "data entry keyer",
            "data entry machine operator",
            "data encoder",
            "data capture",
            "data transcription",
            "data transcriber",
            "records clerk",
            "records specialist",
            "document indexing clerk",
            "document processing clerk",
            "data processing clerk",
            "data processing assistant",
            "information processing clerk",
            "underwriting support specialist",
        ]
    return [query.strip()]


def _query_relevance(job: dict[str, Any], query: str) -> tuple[int, str]:
    """Recall-first relevance scoring: keep phrase and recognized related-title hits."""
    terms = normalize_text(query).split()
    if not terms:
        return 100, "empty query"
    phrase = " ".join(terms)
    title = normalize_text(job.get("title", ""))
    metadata = normalize_text(" ".join([
        " ".join(_string_list(job.get("tags", []))),
        str(job.get("employment_type") or ""),
        str(job.get("seniority") or ""),
    ]))
    summary = normalize_text(job.get("summary", ""))
    description = normalize_text(job.get("description", ""))

    data_entry_query = phrase in {
        "data entry", "data entry jobs", "data entry job", "data entry clerk",
        "data entry operator", "data entry specialist", "data entry keyer",
    }
    if data_entry_query:
        direct_titles = (
            "data entry", "data entry clerk", "data entry specialist",
            "data entry operator", "data entry keyer", "data entry machine operator",
        )
        related_titles = (
            "data encoder", "data capture", "data transcription", "data transcriber",
            "records clerk", "records specialist", "document indexing clerk",
            "document processing clerk", "data processing clerk", "data processing assistant",
            "information processing clerk",
        )
        adjacent_titles = ("underwriting support specialist", "document control clerk", "typist", "word processor")
        for alias in direct_titles:
            if alias in title:
                return 100, "direct data-entry title"
        for alias in related_titles:
            if alias in title:
                return 82, f"related job title: {alias}"
        for alias in adjacent_titles:
            if alias in title:
                return 45, f"adjacent administrative title: {alias}"
        for alias in direct_titles + related_titles:
            if alias in metadata:
                return 75, f"related skill/category: {alias}"
        for alias in adjacent_titles:
            if alias in metadata:
                return 40, f"adjacent administrative skill/category: {alias}"
        if phrase in metadata:
            return 90, "exact phrase in skills/tags"
        if phrase in title:
            return 100, "exact phrase in title"
        # Keep all exact phrase occurrences, even when they are only in the body.
        # This intentionally favors recall; score/reason communicates the weaker evidence.
        if phrase in summary:
            return 42, "phrase in summary; broader match"
        if phrase in description:
            return 35, "exact phrase in full description; broader match"
        if all(term in title for term in terms):
            return 70, "query words in title"
        if all(term in metadata for term in terms):
            return 65, "query words in skills/tags"
        if all(term in summary for term in terms):
            return 30, "query words in summary; broader match"
        if all(term in description for term in terms):
            return 20, "query words scattered in description; broad match"
        return 0, "no query phrase or recognized related-title match"

    if len(terms) == 1:
        if phrase in title:
            return 100, "title keyword"
        if phrase in metadata:
            return 85, "skill/tag keyword"
        if phrase in summary:
            return 42, "summary keyword; broader match"
        if phrase in description:
            return 30, "description-only keyword; broader match"
        return 0, "no useful keyword match"

    if phrase in title:
        return 100, "exact phrase in title"
    if all(term in title for term in terms):
        return 82, "all keywords in title"
    if phrase in metadata:
        return 90, "exact phrase in skills/tags"
    if all(term in metadata for term in terms):
        return 72, "all keywords in skills/tags"
    if phrase in summary:
        return 42, "exact phrase in summary; broader match"
    if all(term in summary for term in terms):
        return 38, "all keywords in summary; broader match"
    if phrase in description:
        return 35, "exact phrase in full description; broader match"
    if all(term in description for term in terms):
        return 20, "query words scattered in full description; broad match"
    return 0, "no query keyword match"


def _matches_query(job: dict[str, Any], query: str) -> bool:
    """Compatibility helper: True only for a reasonably relevant match."""
    score, _reason = _query_relevance(job, query)
    return score >= 45


def _matches_location(job: dict[str, Any], location: str | None) -> bool:
    if not location:
        return True
    wanted = normalize_text(location)
    listed = normalize_text(job.get("location", ""))
    if wanted in listed:
        return True
    if any(word in listed for word in (
        "worldwide", "anywhere", "global", "all countries", "no country restriction"
    )):
        return True
    # A region-wide remote role is normally eligible in member countries unless the source
    # explicitly restricts it further. Use only obvious region mappings, not guesses.
    country_regions = {
        "nigeria": ("africa",), "ghana": ("africa",), "kenya": ("africa",),
        "south africa": ("africa",), "uganda": ("africa",), "rwanda": ("africa",),
        "united states": ("north america",), "usa": ("north america",),
        "canada": ("north america",), "mexico": ("north america",),
        "india": ("asia",), "philippines": ("asia",), "singapore": ("asia",),
        "australia": ("oceania",), "new zealand": ("oceania",),
    }
    return any(region in listed for region in country_regions.get(wanted, ()))


def _date_filter(job: dict[str, Any], cutoff: datetime | None) -> bool | None:
    """True=keep, False=too old, None=the source didn't provide a usable date."""
    if cutoff is None:
        return True
    posted = parse_datetime(job.get("published_at"))
    if posted is None:
        return None
    return posted >= cutoff


def _dedupe(jobs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    unique: list[dict[str, Any]] = []
    by_url: dict[str, dict[str, Any]] = {}
    by_fingerprint: dict[str, dict[str, Any]] = {}

    def enrich(existing: dict[str, Any], incoming: dict[str, Any]) -> None:
        seen_links = {link.get("url") for link in existing.get("source_links", [])}
        for link in incoming.get("source_links", []):
            if link.get("url") not in seen_links:
                existing.setdefault("source_links", []).append(link)
                seen_links.add(link.get("url"))
        # Keep the strongest keyword match when feeds describe one role differently.
        if incoming.get("relevance_score", 0) > existing.get("relevance_score", 0):
            existing["relevance_score"] = incoming["relevance_score"]
            existing["match_reason"] = incoming.get("match_reason", "keyword match")
        # Preserve a richer description or useful fields from the duplicate.
        if len(incoming.get("description", "")) > len(existing.get("description", "")):
            existing["description"] = incoming["description"]
        if len(incoming.get("summary", "")) > len(existing.get("summary", "")):
            existing["summary"] = incoming["summary"]
        for field in ("salary_min", "salary_max", "salary_currency", "salary_period",
                      "employment_type", "seniority", "published_at"):
            if existing.get(field) in (None, "") and incoming.get(field) not in (None, ""):
                existing[field] = incoming[field]
        for tag in incoming.get("tags", []):
            if tag not in existing.setdefault("tags", []):
                existing["tags"].append(tag)

    for job in jobs:
        url_key = _url_key(job.get("job_url", ""))
        fingerprint = "|".join([
            normalize_text(job.get("company", "")),
            normalize_text(job.get("title", "")),
            normalize_text(job.get("location", "")),
        ])
        existing = by_url.get(url_key) or by_fingerprint.get(fingerprint)
        if existing:
            enrich(existing, job)
            continue
        unique.append(job)
        by_url[url_key] = job
        by_fingerprint[fingerprint] = job
    return unique, len(jobs) - len(unique)


def search_jobs(
    query: str,
    *,
    days: int | None = None,
    since: str | date | datetime | None = None,
    location: str | None = None,
    remote_only: bool = True,
    max_results: int = 100,
    sources: list[str] | None = None,
) -> dict[str, Any]:
    """Search configured public job sources and return a JSON-serializable report.

    Example:
        report = search_jobs("data entry", days=5, location="Nigeria")
        report["results"]  # normalized jobs with original links and descriptions

    Args:
        query: Search phrase, e.g. "data entry" or "virtual assistant".
        days: Optional rolling window in days (e.g. 5). Mutually exclusive with since.
        since: Optional date/datetime cutoff; accepts YYYY-MM-DD or datetime.
        location: Optional country or region such as "Nigeria".
        remote_only: Exclude known non-remote jobs by default.
        max_results: Maximum number of matching jobs returned (not pages fetched).
        sources: Optional source IDs to query. Omit to run every configured source.
    """
    query = str(query or "").strip()
    if not query:
        raise ValueError("query cannot be blank")
    if days is not None and since is not None:
        raise ValueError("Use either days or since, not both")
    if days is not None and (not isinstance(days, int) or days < 1):
        raise ValueError("days must be a positive integer")
    if max_results < 1:
        raise ValueError("max_results must be at least 1")

    cutoff: datetime | None = None
    if days is not None:
        cutoff = _now_utc() - timedelta(days=days)
    elif since is not None:
        if isinstance(since, datetime):
            cutoff = since.replace(tzinfo=timezone.utc) if since.tzinfo is None else since.astimezone(timezone.utc)
        elif isinstance(since, date):
            cutoff = datetime.combine(since, datetime.min.time(), tzinfo=timezone.utc)
        else:
            parsed = parse_datetime(str(since))
            if parsed is None:
                raise ValueError("since must be a valid date like '2026-10-01'")
            cutoff = parsed

    requested = list(SOURCE_RUNNERS.keys()) if not sources else list(dict.fromkeys(s.lower() for s in sources))
    unknown = [source for source in requested if source not in SOURCE_RUNNERS]
    if unknown:
        raise ValueError(f"Unknown source(s): {', '.join(unknown)}. Available: {', '.join(SOURCE_RUNNERS)}")

    allow_env = [item.strip().lower() for item in os.getenv("OPPORTUNITY_SOURCES", "").split(",") if item.strip()]
    if not sources and allow_env:
        requested = [source for source in requested if source in allow_env]

    started = _now_utc()
    source_reports: list[dict[str, Any]] = []
    # Sources run in parallel; each adapter paginates sequentially to respect upstream APIs.
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(5, max(1, len(requested)))) as pool:
        futures = {}
        for source_id in requested:
            runner = SOURCE_RUNNERS[source_id][1]
            futures[pool.submit(runner, query, days)] = source_id
        for future in concurrent.futures.as_completed(futures):
            source_id = futures[future]
            try:
                source_reports.append(future.result())
            except Exception as exc:
                source_reports.append(_source_error(source_id, SOURCE_RUNNERS[source_id][0], exc))
    source_reports.sort(key=lambda source: requested.index(source["source_id"]))

    total_raw = sum(len(source.get("jobs", [])) for source in source_reports)
    candidates: list[dict[str, Any]] = []
    excluded_date = excluded_unknown_date = excluded_location = excluded_nonremote = 0
    excluded_by_relevance = 0
    relevance_matches = 0

    for source in source_reports:
        for original_job in source.get("jobs", []):
            score, reason = _query_relevance(original_job, query)
            # Retain weak description-only mentions for review, but not as normal matches.
            if score < 30:
                excluded_by_relevance += 1
                continue

            relevance_matches += 1
            keep_date = _date_filter(original_job, cutoff)
            if keep_date is None:
                excluded_unknown_date += 1
                continue
            if not keep_date:
                excluded_date += 1
                continue
            if not _matches_location(original_job, location):
                excluded_location += 1
                continue
            if remote_only and original_job.get("remote_status") in ("onsite", "hybrid"):
                excluded_nonremote += 1
                continue

            job = dict(original_job)
            job["relevance_score"] = score
            job["match_reason"] = reason
            candidates.append(job)

    deduped, duplicates_removed = _dedupe(candidates)
    deduped.sort(
        key=lambda job: (
            int(job.get("relevance_score", 0)),
            parse_datetime(job.get("published_at")) or datetime.min.replace(tzinfo=timezone.utc),
        ),
        reverse=True,
    )
    strong_matches = [job for job in deduped if int(job.get("relevance_score", 0)) >= 45]
    near_matches = [job for job in deduped if 30 <= int(job.get("relevance_score", 0)) < 45]
    results = strong_matches[:max_results]
    near_matches = near_matches[:min(20, max_results)]

    timeframe_label = (
        f"last {days} day(s)" if days is not None
        else f"since {cutoff.date().isoformat()}" if cutoff is not None
        else "all dates available from each source"
    )
    finished = _now_utc()
    return {
        "query": query,
        "started_at": _iso(started),
        "completed_at": _iso(finished),
        "elapsed_seconds": round((finished - started).total_seconds(), 2),
        "timeframe": timeframe_label,
        "location_filter": location,
        "remote_only": remote_only,
        "max_results": max_results,
        "sources": [
            {key: value for key, value in source.items() if key != "jobs"}
            for source in source_reports
        ],
        "source_jobs_fetched": total_raw,
        "keyword_matches_before_filters": relevance_matches,
        "results_count": len(results),
        "results": results,
        "near_matches_count": len(near_matches),
        "near_matches": near_matches,
        "audit": {
            "duplicates_removed": duplicates_removed,
            "excluded_by_relevance": excluded_by_relevance,
            "excluded_by_timeframe": excluded_date,
            "excluded_unknown_publication_date": excluded_unknown_date,
            "excluded_by_location": excluded_location,
            "excluded_non_remote": excluded_nonremote,
            "source_errors": sum(1 for source in source_reports if source["status"] == "error"),
            "source_partials": sum(1 for source in source_reports if source["status"] == "partial"),
        },
        "coverage_warning": (
            "This searches the configured public feeds, not every job site on the internet. "
            "A missing source, API limit, source-specific retention window, country restriction, "
            "or platform terms can affect coverage. Always open the original listing to confirm "
            "that the position is active and that you are eligible."
        ),
    }


def print_report(report: dict[str, Any], *, description_chars: int = 1000) -> None:
    """Print a human-readable report while preserving all text in report['results']."""
    print(f'\nOPPORTUNITY SEARCH: "{report["query"]}"')
    print(f'Timeframe: {report["timeframe"]} | Remote only: {report["remote_only"]}')
    print(f'Search took {report["elapsed_seconds"]}s; {report["results_count"]} strong match(es), {report.get("near_matches_count", 0)} review candidate(s).')
    print("\nSOURCE STATUS")
    for source in report["sources"]:
        suffix = " [cache]" if source.get("cache_used") else ""
        if source.get("cache_stale"):
            suffix += " [stale cache]"
        print(f'- {source["source_name"]}: {source["status"]}; {source["raw_jobs_count"]} raw jobs{suffix}')
        if source.get("message"):
            print(f'  {source["message"]}')
        if source.get("error"):
            print(f'  ERROR: {source["error"]}')
        if source.get("cache_warning"):
            print(f'  WARNING: {source["cache_warning"]}')

    print(f'\nMATCHES ({report["results_count"]})')
    if not report["results"]:
        print("No high-relevance jobs matched all selected filters in the accessible source results.")
    for index, job in enumerate(report["results"], start=1):
        print(f'\n{index}. {job["title"]} — {job["company"]}')
        if job.get("relevance_score") is not None:
            print(f'   Relevance: {job["relevance_score"]}/100 — {job.get("match_reason", "keyword match")}')
        print(f'   Location: {job["location"]} | Work mode: {job["remote_status"]}')
        print(f'   Published: {job["published_at"] or "Not supplied by source"}')
        if job.get("employment_type"):
            print(f'   Employment: {job["employment_type"]}')
        if job.get("seniority"):
            print(f'   Seniority: {job["seniority"]}')
        if job.get("salary_min") is not None or job.get("salary_max") is not None:
            low = job.get("salary_min") if job.get("salary_min") is not None else "?"
            high = job.get("salary_max") if job.get("salary_max") is not None else "?"
            currency = f' {job["salary_currency"]}' if job.get("salary_currency") else ""
            period = f' / {job["salary_period"]}' if job.get("salary_period") else ""
            print(f"   Salary: {low}–{high}{currency}{period}")
        else:
            print("   Salary: Not stated")
        if job.get("tags"):
            print("   Tags: " + ", ".join(job["tags"][:12]))
        if job.get("summary"):
            print("   Summary: " + re.sub(r"\s+", " ", job["summary"])[:description_chars])
        elif job.get("description"):
            print("   Description: " + re.sub(r"\s+", " ", job["description"])[:description_chars])
        print(f'   Job link: {job["job_url"]}')
        if job.get("apply_url") and job["apply_url"] != job["job_url"]:
            print(f'   Apply link: {job["apply_url"]}')
        print(f'   Source: {job["source_name"]}')
        alternates = [
            link for link in job.get("source_links", [])
            if link.get("url") != job["job_url"]
        ]
        for link in alternates:
            print(f'   Also found at {link.get("source")}: {link.get("url")}')

    if report.get("near_matches"):
        print(f'\nLOWER-CONFIDENCE REVIEW CANDIDATES ({report["near_matches_count"]})')
        print("These matched only in a description or a weaker field; check relevance before applying.")
        for index, job in enumerate(report["near_matches"], start=1):
            print(f'\n{index}. {job["title"]} — {job["company"]}')
            print(f'   Relevance: {job["relevance_score"]}/100 — {job.get("match_reason", "weak keyword match")}')
            print(f'   Location: {job["location"]} | Published: {job.get("published_at") or "Not supplied"}')
            if job.get("summary"):
                print("   Summary: " + re.sub(r"\s+", " ", job["summary"])[:description_chars])
            print(f'   Job link: {job["job_url"]}')
            if job.get("apply_url") and job["apply_url"] != job["job_url"]:
                print(f'   Apply link: {job["apply_url"]}')
            print(f'   Source: {job["source_name"]}')

    print("\nSEARCH AUDIT")
    for key, label in [
        ("duplicates_removed", "Duplicate results merged"),
        ("excluded_by_relevance", "Excluded as weak/incidental keyword mentions"),
        ("excluded_by_timeframe", "Excluded as too old"),
        ("excluded_unknown_publication_date", "Excluded because publication date is unknown"),
        ("excluded_by_location", "Excluded by location filter"),
        ("excluded_non_remote", "Excluded as onsite/hybrid"),
        ("source_errors", "Sources that failed"),
        ("source_partials", "Sources with incomplete pagination"),
    ]:
        print(f'   {label}: {report["audit"][key]}')
    print("\nNOTE: Open the original listing to confirm it is still active and check eligibility.")


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Search multiple public remote-job feeds from your PC or Google Colab."
    )
    parser.add_argument("query", help='Keyword phrase, e.g. "data entry"')
    timeframe = parser.add_mutually_exclusive_group()
    timeframe.add_argument("--days", type=int, help="Rolling publication window, e.g. --days 5")
    timeframe.add_argument("--since", help="Only listings on/after YYYY-MM-DD")
    parser.add_argument("--location", help='Country/region filter, e.g. "Nigeria"')
    parser.add_argument("--include-nonremote", action="store_true", help="Include known onsite/hybrid results")
    parser.add_argument("--max-results", type=int, default=100, help="Maximum displayed results (default: 100)")
    parser.add_argument("--source", action="append", help=f"Source ID to run; repeatable. Available: {', '.join(SOURCE_RUNNERS)}")
    parser.add_argument("--json", action="store_true", help="Print the full JSON report")
    parser.add_argument("--out", help="Also write the full JSON report to a file")
    parser.add_argument("--description-chars", type=int, default=1000, help="Description characters printed per result")
    args = parser.parse_args(argv)

    try:
        if args.days is not None and args.days < 1:
            parser.error("--days must be a positive integer")
        if args.max_results < 1:
            parser.error("--max-results must be at least 1")
        report = search_jobs(
            args.query,
            days=args.days,
            since=args.since,
            location=args.location,
            remote_only=not args.include_nonremote,
            max_results=args.max_results,
            sources=args.source,
        )
        if args.out:
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"Full report saved to {out_path.resolve()}")
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print_report(report, description_chars=max(0, args.description_chars))
        return 0 if report["audit"]["source_errors"] < len(report["sources"]) else 2
    except (ValueError, RuntimeError) as exc:
        print(f"Search failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(_main())
