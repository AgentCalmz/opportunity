export type RemoteStatus = "remote" | "onsite" | "hybrid" | "unknown";

export interface JobOpportunity {
  id: string;
  title: string;
  company: string;
  location: string;
  remoteStatus: RemoteStatus;
  description: string;
  summary: string;
  publishedAt?: string;
  employmentType?: string;
  seniority?: string;
  tags: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  jobUrl: string;
  applyUrl?: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
}

export interface SourceResult {
  sourceId: string;
  sourceName: string;
  status: "ok" | "partial" | "error" | "skipped";
  jobs: JobOpportunity[];
  fetchedAt?: string;
  cacheUsed?: boolean;
  message?: string;
  error?: string;
}

export interface SearchOptions {
  query: string;
  days?: number;
  since?: string;
  location?: string;
  remoteOnly: boolean;
  maxResults: number;
  enabledSources?: string[];
}

export interface SearchReport {
  query: string;
  startedAt: string;
  completedAt: string;
  timeframeLabel: string;
  sources: SourceResult[];
  results: JobOpportunity[];
  excludedByDate: number;
  excludedUnknownDate: number;
  excludedByLocation: number;
  excludedNonRemote: number;
  duplicatesRemoved: number;
}