# Website Vulnerability Scanner (WVS)

[![Bun Runtime](https://img.shields.io/badge/runtime-bun%20v1.3+-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/typescript-%5E5.0-blue?logo=typescript)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/database-postgresql%2016-blue?logo=postgresql)](https://www.postgresql.org)
[![Prisma](https://img.shields.io/badge/orm-prisma%206-teal?logo=prisma)](https://www.prisma.io)
[![Redis](https://img.shields.io/badge/cache%20%26%20queue-redis%207-red?logo=redis)](https://redis.io)

A hosted, safety-first **Dynamic Application Security Testing (DAST)** platform designed for non-destructive vulnerability detection, surface discovery, and compliance auditing.

> **Safety-Kernel First**: WVS is strictly a detection tool, not an exploitation framework. Scans require cryptographic proof of domain ownership (DNS TXT or well-known token verification), adhere to strict rate limits and network blocklists, and abort immediately if target strain or instability is detected.

---

## Architecture Overview

WVS is organized as a Turborepo monorepo powered by the Bun package manager:

```
software/
├── apps/
│   ├── api/             # Express (on Bun) REST API + WebSocket live telemetry gateway (stateless)
│   ├── web/             # React + Vite dashboard single-page application
│   └── worker/          # Scalable scan engine workers (BullMQ job processors)
├── packages/
│   ├── database/        # Prisma schema and client for D1-D6 data stores (@wvs/database)
│   ├── detectors/       # Declarative YAML vulnerability detector catalogue (passive + safe-active)
│   ├── scope-guard/     # Framework-agnostic safety kernel and target boundary enforcement
│   └── shared/          # Shared TypeScript types, DTOs, and WebSocket contracts
├── docs/                # Canonical requirements (SRS v1.2), DFD specifications, and reports
├── docker-compose.yml   # PostgreSQL 16 Alpine and Redis 7 Alpine infrastructure
└── package.json         # Workspace root scripts and orchestration
```

---

## Scan Execution (F.3)

F.3 is split between this API and the orchestrator in `apps/worker`. They never
call each other; the interface is a contract held in `packages/shared`
(`@wvs/shared`), and the decision is recorded in
[ADR-0006](docs/adr/0006-scan-execution-contract.md).

**Triggers and control** (`/api/scans`, unversioned to match the rest of the API):

| Endpoint | Purpose |
| --- | --- |
| `POST /api/scans` | Start a scan; returns the scan id immediately (202) |
| `GET /api/scans` | Cursor-paginated list, filterable by `targetId` and `status` |
| `GET /api/scans/:id` | One scan, with its derived warnings and concurrency state |
| `GET /api/scans/:id/findings` | Read-only finding projection for the live view |
| `POST /api/scans/:id/pause` \| `/resume` \| `/cancel` | Control, along the legal transitions only |

Errors are RFC 9457 problem details (`application/problem+json`); the older
endpoints keep their custom shape. Reads are open to every role, state changes
need `ADMIN`, `ANALYST` or `DEVELOPER`, and organisation scoping always comes
from the session.

Recorded gaps against SRS §3.2.4 on this surface: scan endpoints are unversioned
to match the rest of the API (`/api/auth` is pinned by the authentication
library's base path, so versioning only scans would leave two conventions), and
they do not yet accept idempotency keys. A repeated start is instead refused
because a second active scan of the same target is rejected, and the queue job
id is the scan id.

**Queue.** The API writes the `ScanJob` row (profile, all five limits, and the
scope snapshot), then enqueues `{ scanJobId, organizationId, attempt }` on the
BullMQ queue `wvs-scans` with the job id set to the scan id, so a double submit
cannot create two jobs. The row, not the message, is the source of truth.

**Events.** The orchestrator publishes `scan.status`, `scan.progress`,
`scan.finding` and `scan.warning` to the Redis channel `wvs:scan-events`; every
API instance subscribes and fans them out to its own WebSocket clients on `/ws`
and `/ws/scans/{id}`. Nothing on that channel may have a side effect, because
pub/sub delivers to every instance: a completion email published there would
send once per instance. Side effects belong at the single point of state
transition, in the orchestrator.

---


The persistence layer in [`packages/database`](packages/database) models all 6 core data stores via Prisma ORM:

| Store  | Scope                   | Key Entities & Characteristics                                                                                                                                                                              |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Accounts & Sessions** | `User`, `Session`, `Account`, `Verification`, `TwoFactor`, `Organization`, `Member`, `Invitation`. Better Auth compatible, RBAC (`ADMIN`, `ANALYST`, `DEVELOPER`, `VIEWER`), brute-force lockout, TOTP 2FA. |
| **D2** | **Targets & Scope**     | `Target`, `NetworkBlocklist`. Ownership verification via DNS TXT or HTTP `/.well-known/`, 90-day re-verification cycle, path inclusion/exclusion, scan rate ceilings.                                       |
| **D3** | **Jobs & Checkpoints**  | `ScanJob`, `ScanCheckpoint`. Execution lifecycle (`QUEUED` $\to$ `RUNNING` $\to$ `PAUSED` $\to$ `COMPLETED` / `ABORTED_SAFETY`), state checkpoints for resilient worker recovery, cron scheduling.          |
| **D4** | **Scan Records**        | `CrawledPage`. Attack surface inventory, URL tree, forms, query parameters, HTTP headers, and reduced-confidence tracking.                                                                                  |
| **D5** | **Findings & Evidence** | `Finding`, `FindingEvidence`, `FindingTriageHistory`. Immutable findings (DC-9), cross-scan fingerprinting (`NEW`, `PERSISTING`, `RESOLVED`), 90-day evidence retention and purging (F.6).                  |
| **D6** | **Audit Log & Ledger**  | `AuditLog`, `UrlLedger`, `SystemSetting`. Append-only audit trail for all critical actions, per-scan URL dispatch ledger, and system-wide emergency kill switch.                                            |

---

## Prerequisites

- **[Bun](https://bun.sh)**: v1.3.14 or later
- **[Docker](https://www.docker.com)** & **Docker Compose**: For PostgreSQL 16 and Redis 7
- **Node.js** (optional): v20+ (for tooling compatibility)

---

## Getting Started

### 1. Clone the Repository & Configure Environment

```bash
git clone https://github.com/ksacheth/software-engineering.git
cd software-engineering

# Copy example environment configuration
cp .env.example .env
```

Ensure `.env` has appropriate values. The default configuration connects to the local Docker Compose services.

### 2. Start Infrastructure Services

Spin up PostgreSQL 16 and Redis 7:

```bash
docker compose up -d
```

Verify services are healthy:

```bash
docker compose ps
```

### 3. Install Dependencies

Install all monorepo dependencies using Bun:

```bash
bun install
```

### 4. Setup the Database

Generate the Prisma Client and synchronize the database schema:

```bash
# Generate Prisma client types
bun run db:generate

# Push schema directly to development database
bun run db:push

# (Or run migrations)
# bun run db:migrate:dev
```

### 5. Start Development Servers

Run all workspace applications in development mode:

```bash
bun run dev
```

Or run targeted services:

```bash
# API Server (http://localhost:4100)
cd apps/api && bun run dev

# Prisma Studio database GUI (http://localhost:5555)
bun run db:studio
```

### 6. Email Delivery (optional)

Verification, password-reset, and account-deletion mail is delivered over SMTP.
Step 2 starts **Mailpit**, a local sink that captures every message and forwards
none. Read captured mail at <http://localhost:8025>.

Mailpit is the correct development default. Nothing reaches a real inbox while
the default `SMTP_*` values are in place. To deliver to real inboxes, replace
those values in `.env` and restart the API. No code change is needed, because
`apps/api/src/lib/email.ts` speaks plain SMTP.

| Relay             | Requires                   | Notes                                            |
| ----------------- | -------------------------- | ------------------------------------------------ |
| Mailpit (default) | Nothing                    | Local only; messages never leave the machine     |
| Gmail             | 2FA plus an App Password   | No domain needed; roughly 500 sends/day          |
| SendGrid          | Single Sender Verification | Send from one verified address; no domain needed |
| Resend            | A domain you control       | Verified with SPF/DKIM records                   |

Keep `SMTP_PORT` and `SMTP_SECURE` consistent: port `465` needs
`SMTP_SECURE=true`, while `587` and `1025` need `false`. Also set `SMTP_FROM`
to an address the relay has authorised, or it rejects the send.

A message that fails to send is recorded in `email_outbox` rather than lost
(SRS F.1 §3.2.3). Drain the queue with:

```bash
bun run email:retry
```

The command retries with exponential backoff, parks a message as
`DEAD_LETTER` after 5 attempts, and exits non-zero while any dead letters
remain, so a cron job fails loudly instead of losing mail quietly. An
in-process loop is available via `EMAIL_RETRY_INTERVAL_MS`, but it is off by
default: the drain belongs in `apps/worker`, because an API-instance loop would
send duplicates once more than one instance runs (NFR-SCAL-1).

---

## Available Scripts

From the repository root:

| Command                     | Description                                            |
| --------------------------- | ------------------------------------------------------ |
| `bun run dev`               | Start the API and web app together in development mode |
| `bun run typecheck`         | Run TypeScript compiler checks across all workspaces   |
| `bun run test`              | Run every workspace's tests with a coverage report      |
| `bun run db:generate`       | Generate Prisma client in `@wvs/database`              |
| `bun run db:push`           | Push Prisma schema directly to PostgreSQL              |
| `bun run db:migrate:dev`    | Create and apply database migrations                   |
| `bun run db:migrate:deploy` | Apply pending migrations in production                 |
| `bun run db:studio`         | Launch Prisma Studio web GUI to browse data stores     |
| `bun run email:retry`       | Drain queued transactional email from `email_outbox`   |

---

## Safety Constraints & Operating Principles

1. **Non-Destructive Scanning**: Scanner only issues idempotent HTTP methods (`GET`, `HEAD`, `OPTIONS`) by default. `POST` requests are strictly restricted to forms explicitly approved by users.
2. **Mandatory Authorization (C.2)**: No scan can run against any domain without verified ownership proof. There is no flag or bypass to disable this check.
3. **Emergency Kill Switch (F.8)**: System administrators can activate a global or per-scan kill switch that halts all active workers within 5 seconds.
4. **Data Minimization (C.7 & DC-9)**: Substantiating HTTP evidence (requests/responses) is automatically purged after 90 days, retaining only sanitized finding metadata.

---

## Documentation & Authority

All system design and implementation is governed by the documentation chain:

- **Authoritative SRS**: [`docs/srs/SRS.md`](docs/srs/SRS.md) (Software Requirements Specification v1.2)
- **DFD Specification**: [`docs/dfd/Website_Vulnerability_Scanner_DFD.md`](docs/dfd/Website_Vulnerability_Scanner_DFD.md)
- **Document Authority Rules**: [`docs/README.md`](docs/README.md)
- **Context & Onboarding**: [`CONTEXT.md`](CONTEXT.md)

---

## License

Academic Project - Department of Information Technology, National Institute of Technology Karnataka (NITK), Surathkal.
