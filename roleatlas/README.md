# RoleAtlas — Cloudflare-first job intelligence

RoleAtlas is a separate web app inside this repository. The existing Python/Colab Opportunity CLI is left unchanged. RoleAtlas does not use Render, Supabase, GitHub Actions or a continuously running PC for collection.

## Included

- Cloudflare Worker API and static search interface.
- D1 schema for jobs, source health, employer registry, ATS boards and collection runs.
- R2 raw-source snapshots.
- Four daily Cron collection windows with per-provider cooldowns.
- Feed adapters: Jobicy, Remote OK, Remotive, Arbeitnow, Himalayas and RemoteJobs.org.
- Direct public ATS adapters: Greenhouse, Lever, Ashby and SmartRecruiters.
- Admin-only employer-board registration, source health and manual collection.
- 30-day search window, original listing links, work-mode filters and conservative Nigeria eligibility labels.
- 45-day database retention target. `open`, `stale` and `closed` are separate states; absence from one feed does not automatically mean a job is closed.

## Sourcing and coverage

A 30-day search filter cannot make a provider return older jobs than that provider exposes. RoleAtlas archives listings it actually observes. Historical coverage therefore grows as the collector runs; an initial backfill is possible only for listings still available from a source.

The employer ATS integrations require a verified public company board identifier. There is no universal public endpoint that searches every Greenhouse, Lever, Ashby or SmartRecruiters employer. Register a board only after confirming its slug on the employer's official careers page. This first version includes the registry and provider connectors; it does not invent company identifiers or claim a worldwide employer crawl.

Eligibility is conservative:
- `eligible`: source text indicates Nigeria, Africa, EMEA or worldwide.
- `not_eligible`: source text clearly restricts the role to a region excluding Nigeria.
- `unconfirmed`: source data does not settle the question.

This is a guide, not a promise that an employer will accept an application from a particular country.

## Deploy to Cloudflare

Requirements: Cloudflare account, Node.js 20+, npm and Wrangler.

From the repository root:

```bash
cd roleatlas
npm install
npx wrangler login
```

Create the database and storage bucket:

```bash
npx wrangler d1 create roleatlas-db
npx wrangler r2 bucket create roleatlas-archive
```

Copy the D1 `database_id` printed by Wrangler into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Apply the migration, set the secret and deploy:

```bash
npm run db:migrate:remote
npx wrangler secret put ADMIN_TOKEN
npm run typecheck
npm run deploy
```

Wrangler prints a `workers.dev` URL. The UI and API are hosted by the Worker. Do not commit `ADMIN_TOKEN` or place it in frontend source code.

For local development, use `npm run db:migrate:local` and `npm run dev`.

## Admin

Open the deployed site and choose **Admin**. Paste the secret used for `ADMIN_TOKEN`, then use **Use token** to view feed health or **Run collection now** to start an immediate scan.

For a direct employer integration, provide:
- Company name
- ATS: Greenhouse, Lever, Ashby or SmartRecruiters
- Public board slug/token
- Official domain, careers URL, country and industry where known

The connector only calls public job-listing endpoints. It does not submit applications or access private employer data.

## API

- `GET /api/health`
- `GET /api/metrics`
- `GET /api/jobs?q=data%20analyst&country=Nigeria&days=30&remote=any&page=1`
- `GET /api/admin/sources` (Bearer admin token)
- `POST /api/admin/collect` (Bearer admin token)
- `POST /api/admin/employers` (Bearer admin token)

## Operations and cost

The scheduled collector is capped per invocation and uses source cooldowns (Remotive and Himalayas are checked at most daily; RemoteJobs.org pagination is capped at two 50-job pages per run). Start with the default limits, inspect Cloudflare usage and increase the board batch only when the number of registered employers warrants it. Workers, D1 and R2 are the only required runtime services.