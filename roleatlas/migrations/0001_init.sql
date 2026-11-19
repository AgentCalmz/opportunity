CREATE TABLE IF NOT EXISTS sources (
  source_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  cooldown_hours INTEGER NOT NULL DEFAULT 6,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  last_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  official_domain TEXT,
  careers_url TEXT,
  country TEXT,
  industry TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, official_domain)
);

CREATE TABLE IF NOT EXISTS employer_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employer_id INTEGER NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('greenhouse','lever','ashby','smartrecruiters')),
  board_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'never',
  last_error TEXT,
  last_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, board_key)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  country TEXT,
  remote_status TEXT NOT NULL DEFAULT 'unspecified',
  employment_type TEXT,
  salary TEXT,
  summary TEXT,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  job_url TEXT NOT NULL,
  apply_url TEXT,
  eligibility_status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK(eligibility_status IN ('eligible','not_eligible','unconfirmed')),
  eligibility_note TEXT,
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_verified_open_at TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','stale','closed')),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_published ON jobs(published_at);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_eligibility ON jobs(eligibility_status);

CREATE TABLE IF NOT EXISTS job_sources (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(job_id, source_key)
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger_type TEXT NOT NULL,
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  sources_succeeded INTEGER NOT NULL DEFAULT 0,
  jobs_seen INTEGER NOT NULL DEFAULT 0,
  jobs_saved INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  details TEXT
);

INSERT OR IGNORE INTO sources(source_key,display_name,endpoint,cooldown_hours) VALUES
('jobicy','Jobicy','https://jobicy.com/api/v2/remote-jobs?count=50',6),
('remoteok','Remote OK','https://remoteok.com/api',6),
('remotive','Remotive','https://remotive.com/api/remote-jobs?limit=100',24),
('arbeitnow','Arbeitnow','https://www.arbeitnow.com/api/job-board-api?page=1',12),
('himalayas','Himalayas','https://himalayas.app/jobs/api?limit=20',24),
('remotejobsorg','RemoteJobs.org','https://remotejobs.org/api/v1/jobs?limit=50&offset=0',6);