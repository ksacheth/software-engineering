# WVS Scan Engine Worker (`@wvs/worker`)

Jasmine's worker process for pipeline orchestration, vulnerability detection, deduplication, triage state carry-forward, and external threat intelligence enrichment.

## Architecture

- **Runtime:** Node.js / Bun (Plain TypeScript process - NO NestJS, NO React)
- **Queue Consumer:** BullMQ listening to queue `wvs-scans` (`SCAN_QUEUE_NAME`)
- **Pub/Sub Telemetry:** Redis channel `wvs:scan-events`

## Pipeline Modules

1. **ScanOrchestrator** (`src/orchestrator/scan-orchestrator.ts`): Orchestrates scan job status transitions (`QUEUED` → `RUNNING` (DISCOVERY → DETECTION) → `COMPLETED` / `FAILED`), emits real-time scan events to Redis, and coordinates processing.
   - Claims a scan only if it is `QUEUED`, or `RUNNING` for the job's `attempt` (a resume), and re-checks the row at each checkpoint, so a pause or cancel always wins (ADR-0007).
   - Analyses the pages the crawler stored; it never invents pages.
   - Writes findings, diff records and `COMPLETED` in one transaction, so a crash leaves nothing partial behind.
   - Triage state is not written by the worker: it is keyed by `(target, fingerprint)`, so earlier decisions apply to new findings automatically, and an untriaged fingerprint is `OPEN` (ADR-0003).
2. **MockDetector** (`src/detectors/mock-detector.ts`): Deterministic, offline mock detector producing raw XSS, SQLi, and Security Header findings. Its findings are fabricated from URL patterns, so it is never a default: see [Running the worker](#running-the-worker).
3. **Deduplicator** (`src/processors/deduplicator.ts`): Hashes finding fingerprints (`detectorId + affectedUrl + affectedParameter`) using SHA-256 and groups duplicate findings while tracking occurrence counts.
4. **TriageCarrier** (`src/processors/triage-carrier.ts`): Carries forward prior human triage states (`OPEN`, `CONFIRMED`, `FALSE_POSITIVE`, `ACCEPTED_RISK`, `RESOLVED`) across target scans and computes diffs (`NEW`, `PERSISTING`, `RESOLVED`).
5. **AdvisoryEnricher** (`src/enrichers/advisory-enricher.ts`): OSV (`OSVClient`) and FIRST EPSS (`EPSSClient`) REST API enrichers attaching CVE IDs, CVSS vectors, and exploit probability scores.

## Running the worker

No production detector exists yet, so the worker refuses to start unless the mock one is asked for by name:

```bash
WVS_SCAN_DETECTOR=mock bun apps/worker/src/worker.ts
```

Use it for development and demos only: every scan it runs reports findings that do not exist.

## Running Tests

### Unit & Integration Tests (Offline)

```bash
# Run all worker unit & integration tests
npx bun test apps/worker

# Run individual test suites
npx bun test apps/worker/src/detectors/mock-detector.test.ts
npx bun test apps/worker/src/processors/deduplicator.test.ts
npx bun test apps/worker/src/processors/triage-carrier.test.ts
npx bun test apps/worker/src/enrichers/advisory-enricher.test.ts
npx bun test apps/worker/src/integration.test.ts
```

### OWASP Juice Shop E2E Test (Optional Container Test)

Spin up OWASP Juice Shop in Docker:
```bash
docker run -d -p 3000:3000 bkimminich/juice-shop
```

Execute the E2E integration harness script:
```bash
bun apps/worker/scripts/juice-shop-e2e.ts
```
