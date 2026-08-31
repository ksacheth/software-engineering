# WVS — Website Vulnerability Scanner — Project Context

Academic project, Dept. of Information Technology, NIT Surathkal. SRS v1.0
(3 Aug 2026) + DFD document are the source of truth — this file is a working
summary for onboarding a person or an AI assistant into the codebase, not a
replacement for them.

## What it is

WVS is a hosted **DAST** (Dynamic Application Security Testing) tool —
comparable to OWASP ZAP, Burp Suite, Acunetix, not to infrastructure scanners
like Nessus/Qualys. Given a target URL, it verifies the requester owns/controls
it, crawls the reachable surface, runs passive + safe-active vulnerability
detectors against it, and produces severity-ranked findings exportable as
PDF/HTML/JSON/CSV/SARIF.

**It is a detection tool, not an exploitation tool.** It never exploits a
finding, brute-forces credentials, does DoS/load testing, or scans behind a
login. Authorization (target ownership verification) is a mandatory safety
kernel with no config option to disable it (C.2) — without it the product
would be an anonymous internet-facing attack platform.

## Team & module ownership

| Module | Requirement | Owner |
|---|---|---|
| 0.1 User Authentication & Access Control | F.1 | Deepthi K |
| 0.2 Target Management & Authorisation | F.2 | Deepthi K |
| 0.3 Scan Configuration & Execution | F.3 | Deepthi K |
| 0.4 Discovery (Crawling) | F.4 | Jasmine |
| 0.5 Vulnerability Detection | F.5 | Jasmine |
| 0.6 Findings Management | F.6 | Jasmine |
| 0.7 Reporting & Export | F.7 | **Sacheth Koushal** |
| 0.8 Safety, Auditing & Administration | F.8 | **Sacheth Koushal** |

## Repo layout (Turborepo + bun workspaces)

```
software/
├── apps/
│   ├── api/          # NestJS REST API + WebSocket gateway (stateless, NFR-SCAL-1)
│   ├── web/           # React + Vite dashboard SPA
│   └── worker/         # Scan Engine — BullMQ job processors, horizontally scalable
├── packages/
│   ├── database/       # Prisma schema + client (D1-D6 data stores)
│   ├── detectors/       # YAML detector catalogue: definitions/{passive,active}/
│   ├── scope-guard/      # Framework-agnostic safety-kernel decision logic
│   └── shared/            # Cross-app types/DTOs/WS event contracts
├── bunfig.toml
├── docker-compose.yml    # Postgres 16 + Redis 7
├── .env.example
├── package.json          # workspaces: ["apps/*", "packages/*"] — lives HERE, not bunfig.toml
├── tsconfig.base.json
└── turbo.json
```

**Why the API and worker are separate apps:** §2.1 of the SRS describes the
Application API and Scan Engine Workers as independently-scalable processes
decoupled by a job queue. Crawling/detection are long-running, resource-heavy
jobs — they belong in `apps/worker` as BullMQ processors, not as NestJS HTTP
controllers in `apps/api`. This is what makes NFR-SCAL-1 ("scan throughput
scales by adding workers, no code changes") actually true.

**The three scope-guard-shaped folders are not redundant** — keep this
division clear:
- `packages/scope-guard` — the actual evaluate/dispatch decision logic
  (verification → scope → blocklist → rate limit → ceiling → fresh IP
  resolution), framework-agnostic and unit-testable alone.
- `apps/worker/src/scope-guard` — the interceptor wiring that logic into the
  crawler's and detectors' real outbound HTTP calls.
- `apps/api/src/modules/scope-guard` — the control-plane API (kill switch,
  blocklist CRUD, admin controls) that *configures* the guard; it doesn't
  enforce anything itself.

## Tech stack (Design Constraints, §3.4)

| Layer | Choice | Constraint |
|---|---|---|
| Language | TypeScript, strict mode, client+server | DC-1 |
| Server framework | NestJS | DC-2 |
| Client framework | React + Vite | DC-2 |
| Persistence | PostgreSQL 16+, via Prisma ORM only (no raw SQL) | DC-3 |
| Async/queue | BullMQ backed by Redis 7+ | DC-4 |
| JS rendering (crawler) | Playwright + headless Chromium | DC-5 |
| API surface | REST, OpenAPI 3.1 generated from code; WebSocket for live updates | DC-6 |
| Packaging | Containers, single orchestration definition, ≤8GB RAM | DC-7, C.4 |
| Detector authoring | YAML metadata, validated against a published JSON Schema | DC-8 |
| Data integrity | Findings immutable once written; audit log append-only at DB privilege level; UTC timestamps | DC-9 |
| Package manager | bun | (team choice) |

## Data model (D1–D6, in `packages/database/prisma/schema.prisma`)

| Store | Contents |
|---|---|
| D1 | Accounts, Organisations & Sessions |
| D2 | Targets & Scope (origin, verification token, scope rules, ceilings) |
| D3 | Jobs & Checkpoints (scan-job, worker assignment, pause-checkpoint, cron) |
| D4 | Scan Records (metadata, crawled-page inventory, crawl limits) |
| D5 | Findings, Triage & Evidence (vulnerability record, CVSS, triage state) |
| D6 | Append-only Audit Log / URL Ledger |

## Functional requirements (F.1–F.8) — one line each

1. **F.1** Register/login/MFA, roles (ADMIN/ANALYST/DEVELOPER/VIEWER), org isolation.
2. **F.2** Register targets, prove ownership (DNS TXT / well-known file) before any scan, re-verify ≥ every 90 days, block private/loopback/cloud-metadata addresses.
3. **F.3** Passive/Standard/Thorough profiles, async lifecycle (QUEUED→…→ABORTED_SAFETY), checkpointed resume, ≤5s cancel.
4. **F.4** Crawl in-scope URLs/forms/params, render JS, honor robots.txt/sitemap.xml, mark blocked results reduced-confidence.
5. **F.5** Passive + safe-active detectors (Appendix B catalogue), OSV/EPSS component-version enrichment, stop immediately if own traffic appears to harm the target.
6. **F.6** Dedupe, NEW/PERSISTING/RESOLVED comparison across scans, triage states (OPEN/CONFIRMED/FALSE_POSITIVE/ACCEPTED_RISK/RESOLVED), evidence purge (default 90d).
7. **F.7** PDF/HTML/JSON/CSV/SARIF export, Executive Summary vs Technical Report templates, coverage-limitations statement mandatory.
8. **F.8** Scope Guard kernel (verify→scope→blocklist→rate-limit→ceiling→fresh-IP), 10 req/s default, identifying User-Agent, admin kill switch, append-only audit log.

## Notable NFR targets

- API: 95% of reads < 300ms, 99% < 800ms @ 50 concurrent users (NFR-PERF-1)
- Standard scan of a 200-page target completes in ≤15 min (NFR-PERF-2)
- TLS 1.2+, HSTS, CSP, HttpOnly/Secure/SameSite=Strict cookies (NFR-SEC-1)
- ≥80% statement coverage on scan engine + API (NFR-MAINT-1)
- 20 concurrent scans on 4 workers (NFR-SCAL-1)
- ≥85% detector recall, ≤15% false positives on HIGH/CRITICAL, against the fixture suite (NFR-QUAL-1)

## Constraints to keep in mind while building

- **C.1** Non-destructive only: GET/HEAD/OPTIONS by default; POST only on forms the user explicitly marks safe.
- **C.2** No config path disables authorization — enforce this in code review, not just docs.
- **C.4** Whole stack must run on 8GB RAM commodity hardware for demo.
- **C.5** OSI-approved licenses only; no commercial scanning engine embedded.
- **C.7** No target content retained beyond the evidence retention window.

## Detector catalogue (`packages/detectors/definitions/`)

- `passive/` — P-01…P-31 (header/cookie/TLS/cert checks, secret/version disclosure, etc.)
- `active/` — A-01…A-14 (reflected XSS, SQLi error/boolean-based, CORS misconfig, open redirect, etc.), all restricted to idempotent methods + benign payloads, no data mutation.
- Each entry: detector ID, CWE, OWASP 2021 category, default severity, priority (M/S/C).

## Known open items

- `packages/detectors` doesn't yet have a home for the JSON Schema DC-8
  requires the YAML detectors to validate against — needs a `schema/`
  folder (or equivalent) and a loader/validator.
- Root `package.json` needs `"workspaces": ["apps/*", "packages/*"]` —
  `bunfig.toml` is for bun install/test/registry config, not workspace
  member declaration.