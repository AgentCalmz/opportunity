(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const resultsRoot = $("#job-results");
  const form = $("#search-form");
  const queryInput = $("#query-input");
  const locationInput = $("#location-input");
  const timeFilter = $("#time-filter");
  const modeFilter = $("#mode-filter");
  const sortFilter = $("#sort-filter");
  const refreshButton = $("#refresh-button");
  const clearQuery = $("#clear-query");
  const toast = $("#toast");

  let snapshot = null;
  let allJobs = [];
  let toastTimer = null;
  let visibleCount = 15;
  let savedOnly = false;
  const storageKey = "opportunity-saved-jobs-v1";
  let savedIds = new Set();
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(stored)) savedIds = new Set(stored.filter((value) => typeof value === "string"));
  } catch (_) {
    // Saving is a convenience; search still works if browser storage is disabled.
  }

  const getJobId = (job) => String(job.job_url || job.apply_url || job.url || [
    job.company || "", job.title || "", job.location || ""
  ].join("|"));

  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const safeUrl = (value) => {
    try {
      const url = new URL(String(value || ""), window.location.href);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "#";
    } catch (_) { return "#"; }
  };

  const normalized = (value) => String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const getDate = (job) => {
    const raw = job.published_at || job.published || job.created_at;
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const relativeDate = (date) => {
    if (!date) return "Date not supplied";
    const delta = Date.now() - date.getTime();
    if (delta < 0 && Math.abs(delta) < 60 * 60 * 1000) return "Just posted";
    const minutes = Math.max(0, Math.floor(delta / 60000));
    if (minutes < 60) return minutes < 2 ? "Just posted" : minutes + "m ago";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    const days = Math.floor(hours / 24);
    if (days < 7) return days + "d ago";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const formatExactDate = (date) => date
    ? date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Time not supplied";

  const firstInitials = (name) => {
    const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  };

  const displayMode = (job) => {
    const value = normalized(job.remote_status || job.work_mode || job.work_arrangement);
    if (value.includes("hybrid")) return "hybrid";
    if (value.includes("onsite") || value.includes("on site") || value.includes("office")) return "onsite";
    if (value.includes("remote") || value.includes("worldwide")) return "remote";
    return "unknown";
  };

  const prettyMode = (mode) => ({
    remote: "Remote", hybrid: "Hybrid", onsite: "On-site", unknown: "Work mode not specified"
  }[mode] || "Work mode not specified");

  const salaryLabel = (job) => {
    if (job.salary_text && String(job.salary_text).trim() && !/^0\s*[-–]\s*0$/.test(String(job.salary_text).trim())) return String(job.salary_text).trim();
    const min = job.salary_min, max = job.salary_max;
    if (min == null && max == null) return "";
    const low = min == null ? "—" : Number(min).toLocaleString();
    const high = max == null ? "—" : Number(max).toLocaleString();
    const currency = job.salary_currency ? " " + job.salary_currency : "";
    const period = job.salary_period ? " / " + job.salary_period : "";
    return low + (low === high ? "" : "–" + high) + currency + period;
  };

  const allText = (job) => normalized([
    job.title, job.company, job.location, job.summary, job.description,
    job.employment_type, job.seniority, job.source_name,
    Array.isArray(job.tags) ? job.tags.join(" ") : job.tags,
    Array.isArray(job.eligible_countries) ? job.eligible_countries.join(" ") : job.eligible_countries,
    Array.isArray(job.excluded_countries) ? job.excluded_countries.join(" ") : job.excluded_countries,
    Array.isArray(job.source_links) ? job.source_links.map((item) => item.source).join(" ") : ""
  ].join(" "));

  const queryScore = (job, query) => {
    const q = normalized(query);
    if (!q) return 0;
    const words = q.split(/\s+/).filter(Boolean);
    const title = normalized(job.title);
    const company = normalized(job.company);
    const tags = normalized(Array.isArray(job.tags) ? job.tags.join(" ") : job.tags);
    const summary = normalized(job.summary);
    const description = normalized(job.description);
    let score = 0;
    if (title.includes(q)) score += 100;
    else if (words.every((word) => title.includes(word))) score += 65;
    if (company.includes(q)) score += 24;
    if (tags.includes(q)) score += 35;
    else if (words.every((word) => tags.includes(word))) score += 17;
    if (summary.includes(q)) score += 24;
    else if (words.every((word) => summary.includes(word))) score += 10;
    if (description.includes(q)) score += 14;
    else if (words.every((word) => description.includes(word))) score += 7;
    return score;
  };

  const locationFits = (job, input) => {
    const wanted = normalized(input);
    if (!wanted) return true;
    const location = normalized(job.location);
    const allowed = normalized(Array.isArray(job.eligible_countries) ? job.eligible_countries.join(" ") : job.eligible_countries);
    const excluded = normalized(Array.isArray(job.excluded_countries) ? job.excluded_countries.join(" ") : job.excluded_countries);
    if (excluded && wanted.split(" ").every((word) => excluded.includes(word))) return false;
    if (location.includes(wanted) || allowed.includes(wanted)) return true;
    if (location.includes("worldwide") || location.includes("anywhere") || location.includes("global")) return true;
    // Keep remote jobs without explicit country details as review candidates, not silent misses.
    if (displayMode(job) === "remote" && /(remote|not specified|eligibility may vary|see listing|country eligibility)/.test(location)) return true;
    return false;
  };

  const ageFits = (job, days) => {
    if (!days) return true;
    const date = getDate(job);
    if (!date) return false;
    return date.getTime() >= Date.now() - Number(days) * 86400000;
  };

  const filterJobs = () => {
    const query = queryInput.value.trim();
    const location = locationInput.value.trim();
    const days = Number(timeFilter.value) || 14;
    const mode = modeFilter.value;
    let jobs = allJobs.map((job) => ({ job, score: queryScore(job, query) }));
    jobs = jobs.filter(({ job, score }) => {
      if (query && score <= 0) return false;
      if (savedOnly && !savedIds.has(getJobId(job))) return false;
      if (!locationFits(job, location)) return false;
      if (!ageFits(job, days)) return false;
      if (mode !== "any" && displayMode(job) !== mode) return false;
      return true;
    });
    jobs.sort((a, b) => {
      const aDate = getDate(a.job)?.getTime() || 0;
      const bDate = getDate(b.job)?.getTime() || 0;
      if (sortFilter.value === "relevance" && query && a.score !== b.score) return b.score - a.score;
      return bDate - aDate;
    });
    return jobs;
  };

  const jobCard = ({ job, score }, index) => {
    const title = escapeHtml(job.title || "Untitled opportunity");
    const company = escapeHtml(job.company || "Employer not listed");
    const jobUrl = safeUrl(job.job_url || job.url);
    const applyUrl = safeUrl(job.apply_url || job.job_url || job.url);
    const mode = displayMode(job);
    const date = getDate(job);
    const source = escapeHtml(job.source_name || job.source_id || "Source not specified");
    const savedId = getJobId(job);
    const isSaved = savedIds.has(savedId);
    const saveButton = '<button type="button" class="save-button' + (isSaved ? ' saved' : '') + '" data-save-id="' + escapeHtml(savedId) + '" aria-pressed="' + (isSaved ? 'true' : 'false') + '" title="' + (isSaved ? 'Remove from saved jobs' : 'Save this job') + '"><span>' + (isSaved ? '♥' : '♡') + '</span><span>' + (isSaved ? 'Saved' : 'Save') + '</span></button>';
    const summary = String(job.summary || job.description || "Open the original listing to review the responsibilities and requirements.").replace(/\s+/g, " ").trim();
    const excerpt = escapeHtml(summary.length > 310 ? summary.slice(0, 307) + "…" : summary);
    const salary = salaryLabel(job);
    const employment = job.employment_type ? String(job.employment_type).split(",")[0].trim() : "";
    const location = job.location || "Location not specified";
    const shownLocation = escapeHtml(location.length > 94 ? location.slice(0, 91) + "…" : location);
    const tags = (Array.isArray(job.tags) ? job.tags : String(job.tags || "").split(","))
      .map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, 4);
    const relevance = queryInput.value.trim() ? '<span class="badge relevance">Search signal ' + Math.min(100, Math.round(score)) + '</span>' : "";
    const titleLink = jobUrl === "#" ? title : '<a href="' + escapeHtml(jobUrl) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>';
    const applyLink = applyUrl === "#" ? "" : '<a class="apply-link" href="' + escapeHtml(applyUrl) + '" target="_blank" rel="noopener noreferrer">View opportunity <span>↗</span></a>';
    const salaryFact = salary ? '<span class="job-fact"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18m5-14H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' + escapeHtml(salary) + '</span>' : "";
    const employmentFact = employment ? '<span class="job-fact"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7" width="17" height="13.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 7V4h8v3M3.5 12h17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' + escapeHtml(employment) + '</span>' : "";
    const tagsHtml = tags.length ? '<div class="job-tags-list">' + tags.map((tag) => '<span class="badge">' + escapeHtml(tag) + '</span>').join("") + '</div>' : "";
    return '<article class="job-card" style="animation-delay:' + Math.min(index * 35, 210) + 'ms">' +
      '<div class="job-topline"><div class="company-row"><div class="company-monogram">' + escapeHtml(firstInitials(job.company)) + '</div><span class="company-name">' + company + '</span></div><time class="job-age" datetime="' + escapeHtml(date ? date.toISOString() : "") + '" title="' + escapeHtml(formatExactDate(date)) + '">' + escapeHtml(relativeDate(date)) + '</time></div>' +
      '<h3 class="job-title">' + titleLink + '</h3>' +
      '<div class="job-tags"><span class="badge ' + mode + '">' + escapeHtml(prettyMode(mode)) + '</span>' + (employment ? '<span class="badge">' + escapeHtml(employment) + '</span>' : "") + relevance + '</div>' +
      '<p class="job-description">' + excerpt + '</p>' +
      '<div class="job-facts"><span class="job-fact"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>' + shownLocation + '</span>' + salaryFact + employmentFact + '</div>' +
      tagsHtml +
      '<div class="job-actions"><span class="source-label"><span class="source-favicon">' + escapeHtml(firstInitials(job.source_name || job.source_id)) + '</span>' + source + '</span><div class="job-action-links">' + saveButton + applyLink + '</div></div>' +
      '</article>';
  };

  const showEmpty = (query) => {
    const isFirstBuild = !snapshot || !(snapshot.sources || []).length;
    const title = isFirstBuild ? "Your board is getting ready" : query ? "No matches in this snapshot" : "Nothing found for these filters";
    const description = isFirstBuild
      ? "The first scheduled collection hasn't produced a snapshot yet. Check the repository's Actions tab and run “Refresh listings & deploy website”."
      : query
        ? "Try a broader phrase or clear one of the filters. Search results are limited to the listings currently collected in this snapshot."
        : "Try another location or work mode, or expand the date window. Source retention and publication dates affect what can be shown.";
    resultsRoot.innerHTML = '<div class="empty-state"><div class="empty-symbol">✳</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(description) + '</p><button type="button" id="reset-filters">Reset filters</button></div>';
    $("#reset-filters").addEventListener("click", resetFilters);
  };

  const renderJobs = (resetPage) => {
    if (resetPage) visibleCount = 15;
    const query = queryInput.value.trim();
    const items = filterJobs();
    $("#results-count").textContent = items.length.toLocaleString();
    $("#saved-count").textContent = String(savedIds.size);
    $("#saved-filter").classList.toggle("active", savedOnly);
    $("#saved-filter").setAttribute("aria-pressed", savedOnly ? "true" : "false");
    $("#export-button").disabled = items.length === 0;
    $("#results-heading").textContent = query ? 'Results for "' + (query.length > 37 ? query.slice(0, 34) + "…" : query) + '"' : "Latest listings";
    $("#results-subheading").textContent = items.length + " listing" + (items.length === 1 ? "" : "s") + " match your current filters";
    $("#metric-listings").textContent = allJobs.length.toLocaleString();
    clearQuery.classList.toggle("visible", Boolean(queryInput.value));
    if (!items.length) return showEmpty(query);
    const visible = items.slice(0, visibleCount);
    resultsRoot.innerHTML = visible.map(jobCard).join("") +
      (items.length > visible.length
        ? '<div class="load-more-wrap"><button type="button" class="load-more-button" id="load-more">Load more listings <span>+' + Math.min(15, items.length - visible.length) + '</span></button></div>'
        : '');

    resultsRoot.querySelectorAll(".save-button").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.saveId;
        if (savedIds.has(id)) {
          savedIds.delete(id);
          showToastMessage("Removed from saved jobs.");
        } else {
          savedIds.add(id);
          showToastMessage("Job saved in this browser.");
        }
        try { window.localStorage.setItem(storageKey, JSON.stringify(Array.from(savedIds))); } catch (_) {}
        renderJobs(false);
      });
    });
    const loadMore = $("#load-more");
    if (loadMore) loadMore.addEventListener("click", () => {
      visibleCount += 15;
      renderJobs(false);
    });
  };

  const renderSources = () => {
    const sources = (snapshot && Array.isArray(snapshot.sources)) ? snapshot.sources : [];
    $("#metric-sources").textContent = String(sources.length || 8);
    const failed = sources.filter((source) => source.status === "error").length;
    const partial = sources.filter((source) => source.status === "partial").length;
    const ok = sources.filter((source) => source.status === "ok").length;
    const dot = $("#source-health-dot");
    dot.classList.toggle("error", failed > 0 && ok === 0);
    dot.classList.toggle("warning", partial > 0 || failed > 0);
    $("#source-summary").textContent = sources.length
      ? ok + " healthy · " + partial + " partial · " + failed + " failed. Each source has its own limits."
      : "Source status will appear after the first successful collection.";
    if (!sources.length) {
      $("#source-list").innerHTML = '<div class="source-placeholder">No source snapshot yet.</div>';
      return;
    }
    $("#source-list").innerHTML = sources.map((source) => {
      const status = String(source.status || "pending").toLowerCase();
      const label = status === "ok" ? "Healthy" : status === "partial" ? "Partial" : status === "error" ? "Failed" : "Pending";
      const count = Number(source.raw_jobs_count || 0).toLocaleString() + " fetched" + (source.cache_used ? " · cached" : "");
      return '<div class="source-item"><span class="source-symbol">' + escapeHtml(firstInitials(source.source_name || source.source_id)) + '</span><span><span class="source-name">' + escapeHtml(source.source_name || source.source_id || "Source") + '</span><span class="source-count">' + escapeHtml(count) + '</span></span><span class="source-status ' + escapeHtml(status) + '">' + label + '</span></div>';
    }).join("");
  };

  const renderFreshness = () => {
    const raw = snapshot && (snapshot.completed_at || snapshot.started_at);
    const date = raw ? new Date(raw) : null;
    const validDate = date && !Number.isNaN(date.getTime());
    if (!validDate) {
      $("#freshness-label").textContent = "Awaiting first refresh";
      $("#updated-time").textContent = "Not generated yet";
      return;
    }
    $("#freshness-label").textContent = "Updated " + relativeDate(date);
    $("#updated-time").textContent = formatExactDate(date);
  };

  const exportCsv = () => {
    const rows = filterJobs().map(({ job }) => job);
    if (!rows.length) {
      showToastMessage("There are no current results to export.");
      return;
    }
    const columns = [
      ["title", "Job title"], ["company", "Company"], ["location", "Location"],
      ["remote_status", "Work mode"], ["published_at", "Published"],
      ["employment_type", "Employment type"], ["seniority", "Seniority"],
      ["salary_min", "Salary minimum"], ["salary_max", "Salary maximum"],
      ["salary_currency", "Currency"], ["salary_period", "Salary period"],
      ["job_url", "Listing URL"], ["apply_url", "Application URL"], ["source_name", "Source"]
    ];
    const csvCell = (value) => {
      const text = value == null ? "" : Array.isArray(value) ? value.join("; ") : String(value);
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const csv = [columns.map((column) => csvCell(column[1])).join(",")]
      .concat(rows.map((job) => columns.map((column) => csvCell(job[column[0]])).join(",")))
      .join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "opportunity-results-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    showToastMessage(rows.length + " listing(s) exported to CSV.");
  };

  const loadSnapshot = async (showToastOnSuccess) => {
    refreshButton.disabled = true;
    refreshButton.classList.add("spinning");
    try {
      const url = new URL("./data/jobs.json", window.location.href);
      url.searchParams.set("v", String(Date.now()));
      const response = await fetch(url.href, { cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot request failed (" + response.status + ")");
      snapshot = await response.json();
      allJobs = Array.isArray(snapshot.results) ? snapshot.results : [];
      renderFreshness();
      renderSources();
      renderJobs(true);
      if (showToastOnSuccess) showToastMessage("Snapshot reloaded.");
    } catch (error) {
      resultsRoot.innerHTML = '<div class="error-state"><div class="empty-symbol">!</div><h3>Could not load the job snapshot</h3><p>Check your connection and confirm the collection workflow has generated site/data/jobs.json.</p><button type="button" id="retry-load">Try again</button></div>';
      $("#retry-load").addEventListener("click", () => loadSnapshot(true));
      $("#freshness-label").textContent = "Snapshot unavailable";
      if (showToastOnSuccess) showToastMessage("Snapshot could not be reloaded.");
    } finally {
      refreshButton.disabled = false;
      refreshButton.classList.remove("spinning");
    }
  };

  const showToastMessage = (message) => {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  };

  const resetFilters = () => {
    queryInput.value = "";
    locationInput.value = "";
    timeFilter.value = "14";
    modeFilter.value = "any";
    sortFilter.value = "newest";
    document.querySelectorAll(".quick-chip").forEach((chip) => chip.classList.remove("active"));
    savedOnly = false;
    renderJobs(true);
    showToastMessage("Filters cleared.");
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    renderJobs(true);
    $("#results-heading").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  queryInput.addEventListener("input", () => {
    clearQuery.classList.toggle("visible", Boolean(queryInput.value));
    document.querySelectorAll(".quick-chip").forEach((chip) => chip.classList.toggle("active", normalized(chip.dataset.query) === normalized(queryInput.value)));
    renderJobs(true);
  });
  queryInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); renderJobs(true); } });
  clearQuery.addEventListener("click", () => { queryInput.value = ""; renderJobs(true); queryInput.focus(); document.querySelectorAll(".quick-chip").forEach((chip) => chip.classList.remove("active")); });
  document.querySelectorAll(".quick-chip").forEach((chip) => chip.addEventListener("click", () => {
    queryInput.value = chip.dataset.query || "";
    document.querySelectorAll(".quick-chip").forEach((item) => item.classList.toggle("active", item === chip));
    renderJobs(true);
    $("#results-heading").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  [locationInput, timeFilter, modeFilter, sortFilter].forEach((element) => element.addEventListener("change", () => renderJobs(true)));
  $("#saved-filter").addEventListener("click", () => { savedOnly = !savedOnly; renderJobs(true); });
  $("#export-button").addEventListener("click", exportCsv);
  refreshButton.addEventListener("click", () => loadSnapshot(true));

  loadSnapshot(false);
})();