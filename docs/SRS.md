# Software Requirements Specification

## Website Vulnerability Scanner

**Version 2.0 — 2 August 2026**

Prepared in accordance with IEEE Std 830-1998, *Recommended Practice for Software Requirements Specifications*.

---

## Table of Contents

1. Introduction
2. Overall Description
3. Specific Requirements
4. Appendices

---

# 1. Introduction

## 1.1 Purpose

This SRS defines the functional and non-functional requirements for the **Website Vulnerability Scanner (WVS)**, a web-based application that performs automated security assessment of publicly reachable web applications and presents the results through an interactive dashboard. It is written for project supervisors and examiners, as the authoritative statement of what the system shall do; for the development team, as the input to design, implementation, and testing; and for future maintainers.

This document describes *what* the system shall do, not *how*, except where an implementation choice is itself a requirement (§3.4).

## 1.2 Scope

WVS accepts a target web application identified by URL, verifies that the requesting user is authorised to test that target, crawls the target to discover its reachable surface, executes a catalogue of vulnerability detectors, and produces a severity-ranked set of findings with supporting evidence and remediation guidance. Results are viewable live in a browser dashboard and exportable as PDF, HTML, JSON, CSV, and SARIF reports.

WVS is a **detection** tool, not an exploitation tool. It does not:

- Exploit discovered vulnerabilities (shell access, data extraction, privilege escalation)
- Scan behind a login session (deferred — see Appendix D)
- Perform denial-of-service, stress, or load testing
- Brute-force credentials
- Use blind or time-based injection techniques
- Scan non-web ports, or native mobile/desktop software
- Apply remediation automatically — it reports; humans remediate

**Legal and ethical position.** Unauthorised scanning of computer systems is a criminal offence in most jurisdictions (Information Technology Act 2000, CFAA, Computer Misuse Act 1990). WVS is for use **only** against targets the user owns or has written permission to test. The authorisation controls in §3.1 (FR-2) are mandatory requirements and shall not be bypassable through configuration. During development and demonstration, scanning is permitted only against the project's own vulnerable fixture application, locally hosted intentionally-vulnerable training applications, or targets with documented written authorisation.

## 1.3 Definitions, Acronyms, and Abbreviations

| Term | Definition |
|---|---|
| **Target** | A web application, identified by an origin (scheme + host + port), registered in the system for scanning. |
| **Scan** | A single bounded execution of the scan engine against one target, producing zero or more findings. |
| **Detector** | A self-contained module identifying one class of vulnerability or misconfiguration. |
| **Finding** | A single detected issue: a detector identifier, location, evidence, severity, and remediation guidance. |
| **Evidence** | The retained request/response data substantiating a finding, so a human can independently verify it. |
| **Crawl** | The discovery phase enumerating reachable URLs, forms, and parameters within scope. |
| **Scope** | The rules determining which URLs a scan may and may not request. |
| **Passive check** | A detector drawing conclusions only from traffic the scanner would generate anyway; no crafted payloads. |
| **Safe active check** | A detector sending crafted but non-destructive requests: idempotent methods, benign payloads. |
| **Ownership verification** | The process by which a user demonstrates administrative control of a target before scanning is permitted. |

**Acronyms:** CORS, CSP, CSRF, CVE, CVSS, CWE, DAST (Dynamic Application Security Testing), EPSS (Exploit Prediction Scoring System), HSTS, OSV (Open Source Vulnerabilities database), OWASP, SARIF, SQLi, SSRF, TLS, XSS.

**Notation:** `FR-x.y` — functional requirement; `NFR-CAT-n` — non-functional requirement (CAT: PERF, SEC, USE, REL, MAINT, SCAL, PORT); `C-n` — project constraint (§2.4); `DC-n` — design constraint (§3.4). **Shall** = mandatory, **should** = recommended, **may** = optional (RFC 2119). Priorities: **M** = must (absence is a project failure), **S** = should (omission needs justification), **C** = could (if schedule permits).

## 1.4 References

1. IEEE Std 830-1998, *IEEE Recommended Practice for Software Requirements Specifications*.
2. OWASP Top 10:2021 — The Ten Most Critical Web Application Security Risks.
3. OWASP Web Security Testing Guide (WSTG), v4.2.
4. FIRST, *Common Vulnerability Scoring System v3.1: Specification Document*.
5. MITRE, *Common Weakness Enumeration (CWE)*.
6. OASIS, *Static Analysis Results Interchange Format (SARIF) Version 2.1.0*.
7. Open Source Vulnerabilities (OSV) database schema and API.
8. FIRST, *Exploit Prediction Scoring System (EPSS) Model and API Specification*.

## 1.5 Overview

Section 2 describes the product in context. Section 3 lists the numbered, testable requirements — the core of this document. Sections 4–7 define the main user flows, data, validation strategy, and traceability. Section 8 contains supporting catalogues and reference material.

---

# 2. Overall Description

## 2.1 Product Perspective

WVS is a new, self-contained, multi-tenant hosted product. It is decomposed into cooperating subsystems:

```
                    ┌─────────────────────────────┐
                    │      Human Actors           │
                    │  Analyst · Developer ·      │
                    │  Viewer · Administrator     │
                    └──────────────┬──────────────┘
                                   │ HTTPS
                    ┌──────────────▼──────────────┐
                    │   Web Dashboard (SPA)       │
                    │   React + TypeScript        │
                    └──────────────┬──────────────┘
                        REST + WebSocket
                    ┌──────────────▼──────────────┐
                    │      Application API        │
                    │  Auth · Targets · Scans ·   │
                    │  Findings · Reports         │
                    └───┬───────────────────┬─────┘
                        │                   │
              ┌─────────▼────────┐   ┌──────▼────────┐
              │   Job Queue      │   │  PostgreSQL   │
              │   (Redis)        │   │  (Prisma ORM) │
              └─────────┬────────┘   └───────────────┘
                        │
              ┌─────────▼──────────────────────────┐
              │        Scan Engine Workers         │
              │  Scope Guard → Crawler →           │
              │  Detector Pipeline → Normaliser    │
              └─────────┬──────────────────────────┘
                        │ HTTP/HTTPS (rate-limited, scope-enforced)
              ┌─────────▼────────┐   ┌──────────────────┐
              │  Target Website  │   │ Vulnerability    │
              │  (external)      │   │ Intel (OSV/EPSS) │
              └──────────────────┘   └──────────────────┘
```

| Subsystem | Responsibility |
|---|---|
| **Web Dashboard** | Single-page application: authentication, target management, scan control, live progress, finding triage, report export. |
| **Application API** | Stateless HTTP API: validation, authentication/authorisation, persistence, job enqueueing, report generation. |
| **Job Queue** | Durable queue decoupling scan requests from execution; retry, priority, cancellation. |
| **Scan Engine Workers** | Horizontally scalable processes consuming scan jobs and running the crawl + detection pipeline. |
| **Scope Guard** | The safety kernel: every outbound request passes through it (authorisation, scope, rate limits, network blocks). |
| **Database** | Durable store for users, targets, scans, findings, evidence, and audit records. |

**Positioning.** WVS belongs to the Dynamic Application Security Testing (DAST) category — comparable to OWASP ZAP, Burp Suite, and Acunetix — not to infrastructure vulnerability assessment products such as Nessus or Qualys. It probes an application's own code for defects rather than matching installed software against CVE feeds. Because WVS is a publicly reachable hosted service that originates its own outbound traffic — unlike installed scanners, which can devolve authorisation to their operator — authorisation is enforced as a mandatory safety kernel (C-2, FR-2.2, FR-8.1, FR-8.2). Without it, the product would constitute an anonymous, internet-facing attack platform.

## 2.2 Product Functions

| Group | Summary |
|---|---|
| **F1 — Account and Access Management** | Registration, authentication, sessions, role-based authorisation, organisation-scoped data isolation. |
| **F2 — Target Management and Authorisation** | Target registration, mandatory proof of ownership, scope definition, target lifecycle. |
| **F3 — Scan Configuration and Execution** | Scan profiles, scheduling, queueing, execution, live progress, pause/resume/cancel. |
| **F4 — Discovery (Crawling)** | Scope-bounded enumeration of URLs, forms, and parameters, including JavaScript-rendered content. |
| **F5 — Vulnerability Detection** | Execution of the passive and safe-active detector catalogue (Appendix A). |
| **F6 — Findings Management** | Normalisation, deduplication, severity assignment, evidence retention, triage, historical comparison. |
| **F7 — Reporting and Export** | Reports in PDF, HTML, JSON, CSV, and SARIF, for technical and summary audiences. |
| **F8 — Safety, Auditing, and Administration** | Rate limiting, blocklists, SSRF protection, kill switch, immutable audit log, system administration. |

## 2.3 User Classes

| Class | Technical level | Primary need | Role |
|---|---|---|---|
| **Security Analyst** | High — OWASP categories, HTTP, exploitation concepts | Full scan control, raw evidence, triage workflow | `ANALYST` |
| **Developer** | Medium — web development, limited security specialism | Clear explanations, remediation guidance, SARIF export | `DEVELOPER` |
| **Viewer / Stakeholder** | Low — non-technical | Posture summary, trends, exportable PDF | `VIEWER` |
| **System Administrator** | High — operates the WVS deployment | User management, quotas, audit review, system health | `ADMIN` |

The dashboard accommodates this spread with a layered view: plain-language summary by default, technical evidence on demand (NFR-USE-1).

## 2.4 Constraints

| # | Constraint |
|---|---|
| C-1 | The scan engine shall never issue a request that mutates target state. Only `GET`, `HEAD`, and `OPTIONS` are permitted by default; `POST` only against forms explicitly marked safe by the user, and never with destructive payloads. |
| C-2 | Scanning is permitted only against targets whose ownership is verified per FR-2.2. There shall be no configuration option that disables this. |
| C-3 | The system is developed within a single academic term by a student team, ruling out capabilities requiring sustained maintenance (e.g. a self-maintained exploit database). |
| C-4 | The full stack shall run on commodity hardware — a single machine with 8 GB RAM — for demonstration. |
| C-5 | All third-party dependencies shall carry OSI-approved licences; no commercially licensed scanning engine shall be embedded. |
| C-6 | The implementation language shall be TypeScript across client and server (DC-1). |
| C-7 | Personal data shall be limited to what authentication and audit require; no target content shall be retained beyond the evidence retention window (FR-6.3). |

## 2.5 Assumptions and Dependencies

**Assumptions:**

- Target applications are reachable over the public internet from the deployment environment.
- Users have sufficient administrative control of targets to publish a DNS TXT record or a file under `/.well-known/`.
- Targets respond to well-formed HTTP requests without aggressive bot mitigation; otherwise crawls are incomplete and the scan reports reduced confidence (FR-4.5).
- Public vulnerability advisory data remains freely accessible under its current terms.
- Targets are conventional HTTP/HTTPS applications, not WebSocket-only or gRPC-only services.

**Dependencies:**

| # | Dependency | Type |
|---|---|---|
| D-1 | Node.js LTS runtime (v22 or later) | Runtime |
| D-2 | PostgreSQL 16 or later | Runtime |
| D-3 | Redis 7 or later | Runtime |
| D-4 | Headless Chromium (via Playwright) for JavaScript rendering | Runtime |
| D-5 | OSV advisory API and FIRST EPSS API | External service |
| D-6 | SMTP relay for transactional email | External service |
| D-7 | A registered domain and TLS certificate for the WVS deployment itself | Deployment |

---

# 3. Specific Requirements

## 3.1 Functional Requirements

Grouped by function group (F1–F8, §2.2). Every requirement is uniquely identified, prioritised (M/S/C, §1.3), and independently verifiable.

### FR-1 — Account and Access Management

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | The system shall allow registration with an email address and password, rejecting duplicate emails, and shall require email confirmation (link expires after 24 hours) before the account may register a target or initiate a scan. | M |
| FR-1.2 | The system shall enforce passwords of at least 12 characters, reject passwords in a known-breached corpus, and store passwords only as Argon2id salted hashes. | M |
| FR-1.3 | The system shall issue a short-lived access token (≤ 15 minutes) and a refresh token (≤ 7 days), and shall lock an account for 15 minutes after 5 consecutive failed logins, notifying the account holder by email. | M |
| FR-1.4 | The system shall support the roles `ADMIN`, `ANALYST`, `DEVELOPER`, and `VIEWER` (Appendix C), associate every user with exactly one organisation, and ensure no user can read or modify another organisation's targets, scans, findings, or reports. | M |
| FR-1.5 | The system shall allow a user to terminate any or all of their active sessions. | S |
| FR-1.6 | The system shall allow a user to enable TOTP two-factor authentication. | C |
| FR-1.7 | The system shall allow account deletion, removing personal data and anonymising retained audit records within 30 days. | S |

### FR-2 — Target Management and Authorisation

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | The system shall allow an `ANALYST` or above to register a target by origin (scheme, host, optional port) and label, validating syntax, `http`/`https` scheme, and public DNS resolution. | M |
| FR-2.2 | The system shall require proof of control before any scan of a target, supporting at least: (a) a system-issued token as a DNS TXT record; (b) the token at `https://<host>/.well-known/wvs-verification.txt`. | M |
| FR-2.3 | The system shall re-verify ownership at least every 90 days and block further scans of a target that fails re-verification. | M |
| FR-2.4 | The system shall refuse to register, verify, or scan any target resolving to a loopback, link-local, RFC 1918, or carrier-grade NAT address, a cloud metadata endpoint, or any entry on an administrator-editable blocklist pre-populated with government, financial, healthcare, and critical-infrastructure domains. | M |
| FR-2.5 | The system shall allow per-target scope definition: in-scope host patterns, path include/exclude patterns, parameters to leave untouched, and maximum crawl depth. | M |
| FR-2.6 | The system shall require an affirmative authorisation acknowledgement at registration, recorded immutably with timestamp and source IP. | M |
| FR-2.7 | The system shall allow archiving a target (history retained, new scans blocked) and permanently deleting a target (scans, findings, and evidence cascade; audit records are anonymised, not deleted). | S |

### FR-3 — Scan Configuration and Execution

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | The system shall provide built-in profiles: **Passive** (no crafted payloads), **Standard** (passive plus safe active checks), and **Thorough** (Standard with wider crawl limits and a larger wordlist). | M |
| FR-3.2 | The system shall allow custom profiles selecting individual detectors from Appendix A. | S |
| FR-3.3 | The system shall allow per-scan configuration of request rate, concurrency, total requests, crawl depth, page count, request timeout, and custom headers. | M |
| FR-3.4 | The system shall execute scans asynchronously (enqueue and return immediately), report lifecycle state as `QUEUED`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED`, or `ABORTED_SAFETY`, and resume an interrupted scan from its last checkpoint after a worker failure. | M |
| FR-3.5 | The system shall stream live progress to the dashboard, updating at least every 2 seconds: current phase, pages crawled, requests issued, detectors completed, findings so far. | M |
| FR-3.6 | The system shall allow pause, resume, and cancel; cancellation shall halt all outbound requests within 5 seconds. | M |
| FR-3.7 | The system shall enforce administrator-configurable per-organisation quotas on concurrent running scans and scans per calendar day. | M |
| FR-3.8 | The system shall allow scheduling of recurring scans on a daily, weekly, or monthly cadence. | S |
| FR-3.9 | The system shall record, for every scan, the exact profile, detector versions, and configuration used, so a historical scan's conditions are reconstructible. | M |
| FR-3.10 | The system shall notify the requesting user by email and in-app notification upon scan completion or failure. | S |

### FR-4 — Discovery (Crawling)

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | The system shall discover reachable URLs from the target origin via in-scope hyperlinks, form actions, and resource references, rendering JavaScript-driven pages in a headless browser to find client-side routes and API calls. | M |
| FR-4.2 | The system shall parse `robots.txt` and `sitemap.xml` for candidate URLs, honouring `robots.txt` exclusions by default; any override shall be recorded in the audit log (FR-8.5). | M |
| FR-4.3 | The system shall enumerate, per discovered page, its forms (method, action URL, input fields) and URL query parameters. | M |
| FR-4.4 | The system shall normalise and deduplicate URLs differing only in session identifiers, cache-busting parameters, or query-parameter ordering. | M |
| FR-4.5 | The system shall detect indicators of blocking (sustained `403`, `429`, or CAPTCHA-bearing responses) and mark affected results reduced-confidence, rather than reporting absence of findings as absence of vulnerabilities. | M |
| FR-4.6 | The system shall respect configured crawl depth, page count, and total request ceilings, terminating discovery cleanly and recording which limit bound the scan. | M |
| FR-4.7 | The system shall detect and avoid crawl traps: infinitely recursive paths, calendar-style parameter spaces, self-referential redirect chains. | S |
| FR-4.8 | The system shall record the discovered site structure and make it viewable as a navigable tree. | C |

### FR-5 — Vulnerability Detection

| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | The system shall implement all detectors marked **M** in the catalogue at Appendix A. | M |
| FR-5.2 | The system shall separate detection *knowledge* from *engine*: detectors shall be expressed as declarative YAML templates (validated against a published JSON Schema at load time; a malformed template is refused without affecting others; administrators may load templates without redeploying) wherever request-and-match logic suffices, and as native modules behind the same registration interface otherwise. | M |
| FR-5.3 | The system shall execute passive detectors against every in-scope response without issuing additional requests. | M |
| FR-5.4 | The system shall restrict active detectors to non-destructive, idempotent probes with benign marker payloads; no payload shall attempt data modification, exfiltration, command execution, or file writing. | M |
| FR-5.5 | The system shall assign each finding a CVSS v3.1 base score and derived severity (Appendix B), map it to a CWE identifier and OWASP Top 10:2021 category, and assign a confidence of `CONFIRMED`, `FIRM`, or `TENTATIVE`. | M |
| FR-5.6 | The system shall correlate fingerprinted component versions against the OSV database and raise a finding for each applicable known vulnerability. | S |
| FR-5.7 | The system shall, for findings carrying a CVE identifier, retrieve and display the EPSS exploitation-probability score alongside CVSS; findings without a CVE display CVSS alone, and an absent EPSS score shall not be presented as low risk. | C |
| FR-5.8 | The system shall isolate detector failures: an exception in one detector shall be logged and shall not terminate the scan or affect other detectors. | M |
| FR-5.9 | The system shall halt a scan and transition it to `ABORTED_SAFETY` if its own traffic is degrading the target — sustained `5xx` responses or response times exceeding five times the observed baseline. | M |
| FR-5.10 | The system shall support re-evaluation of a completed scan by running passive detectors against its retained evidence, without new target traffic; results shall be marked with original and re-evaluation dates, excluded from scan quotas, and unavailable once evidence has been purged (FR-6.3). | S |

### FR-6 — Findings Management

| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | The system shall deduplicate findings within a scan: the same weakness at the same location is reported once, with all affected instances listed as occurrences. | M |
| FR-6.2 | The system shall present, for every finding: title, plain-language description, severity, CVSS vector, confidence, CWE, OWASP category, affected location, evidence, and remediation guidance. | M |
| FR-6.3 | The system shall retain the sanitised HTTP request/response pair substantiating each finding, redact credentials, session tokens, and recognised personal data, and purge evidence after a configurable retention period defaulting to 90 days. | M |
| FR-6.4 | The system shall allow setting a finding's triage status to `OPEN`, `CONFIRMED`, `FALSE_POSITIVE`, `ACCEPTED_RISK`, or `RESOLVED` with an optional justification, and shall carry triage decisions forward across scans of the same target. | M |
| FR-6.5 | The system shall compare a completed scan against the previous scan of the same target, classifying each finding as `NEW`, `PERSISTING`, or `RESOLVED`. | M |
| FR-6.6 | The system shall allow filtering and sorting of findings by severity, confidence, status, detector, OWASP category, and URL. | M |
| FR-6.7 | The system shall present a target's posture over time as a trend of finding counts by severity per scan. | S |
| FR-6.8 | The system shall allow assigning a finding to another user in the same organisation. | C |

### FR-7 — Reporting and Export

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | The system shall generate a report for any completed scan in PDF, HTML, JSON, CSV, and SARIF v2.1.0, the SARIF consumable by GitHub code scanning without transformation. | M |
| FR-7.2 | The system shall provide at least two templates: an **Executive Summary** (posture overview, severity distribution, trend, no raw evidence) and a **Technical Report** (all findings with full evidence and remediation detail). | M |
| FR-7.3 | The system shall include in every report: target identity, scan timestamps, profile used, scope definition, detector versions, and any coverage limitations encountered — including an explicit statement that unauthenticated scanning is not a complete assessment. | M |
| FR-7.4 | The system shall allow filtering a report's contents by severity threshold and triage status, and shall generate reports asynchronously with notification when ready. | S |
| FR-7.5 | The system shall allow a time-limited shareable link to a report, expiring after a user-selected period not exceeding 30 days. | C |

### FR-8 — Safety, Auditing, and Administration

| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | The system shall route every outbound scan request through a single Scope Guard enforcing, in order: target verification status, scope rules, network blocklist, rate limit, and request ceiling. A request failing any check shall not be issued. | M |
| FR-8.2 | The system shall resolve target hostnames and validate the resolved IP immediately before connection, rejecting private, loopback, link-local, and metadata addresses, to prevent DNS-rebinding-based SSRF against the scanner's own network. | M |
| FR-8.3 | The system shall apply a default outbound rate limit of 10 requests per second per target, configurable within an administrator-set ceiling. | M |
| FR-8.4 | The system shall provide an administrator kill switch that immediately halts all running scans system-wide. | M |
| FR-8.5 | The system shall maintain an append-only audit log of authentication events, target registrations, verification attempts and outcomes, authorisation acknowledgements, scan initiation and termination, configuration overrides, report exports, and administrative actions; records shall not be editable or deletable through the application. | M |
| FR-8.6 | The system shall record, for every scan, the full list of URLs requested, so a target owner can reconcile the scanner's traffic against their own server logs. | M |
| FR-8.7 | The system shall identify itself in every outbound request via a `User-Agent` header naming the product and providing a contact URL. | M |
| FR-8.8 | The system shall allow an administrator to view, suspend, and reactivate user accounts, and to adjust per-organisation quotas. | M |
| FR-8.9 | The system shall allow an administrator to review the audit log with filtering by actor, action type, target, and time range, and shall expose a health endpoint reporting API, database, queue, and worker-pool status. | S |

## 3.2 External Interface Requirements

### 3.2.1 User Interfaces

| Screen | Purpose |
|---|---|
| Sign in / Register | Authentication and email confirmation |
| Dashboard home | Posture across all targets, recent scans, severity distribution |
| Targets list | All targets with verification status and last scan result |
| Target detail | Scope configuration, verification state, scan history, trend |
| New scan | Profile selection, configuration, quota display |
| Live scan view | Phase, counters, streaming findings, pause/cancel controls |
| Findings list | Filterable, sortable, colour- *and* label-coded by severity |
| Finding detail | Plain-language explanation, evidence, remediation, triage controls |
| Reports | Template and format selection, generation status, download |
| Administration | Users, quotas, blocklist, audit log, kill switch |

Severity shall be conveyed by label and shape as well as colour; all views shall be operable by keyboard alone; the layout shall be responsive per NFR-USE-2.

### 3.2.2 Hardware Interfaces

None. The system requires no specialised hardware beyond a standard server or workstation.

### 3.2.3 Software Interfaces

| External system | Purpose | Failure behaviour |
|---|---|---|
| OSV / EPSS advisory APIs | Map component versions to CVEs; exploitation probability (FR-5.6, FR-5.7) | Scan proceeds; affected findings suppressed and the degradation recorded on the scan |
| SMTP relay | Verification and notification email | Queued for retry; account creation not blocked |
| Public DNS resolvers | Target resolution and TXT-record verification | Scan fails with a clear diagnostic |
| Headless Chromium (Playwright) | JavaScript rendering during crawl | Pages that fail to render are crawled as static HTML and the limitation recorded |

### 3.2.4 Communications Interfaces

| Interface | Protocol | Notes |
|---|---|---|
| Client ↔ API | HTTPS (TLS 1.2+), REST/JSON under `/api/v1`, documented by generated OpenAPI 3.1 | Bearer-token auth; RFC 9457 problem-details errors; cursor pagination; idempotency keys on mutating endpoints |
| Client ↔ live updates | WSS at `/ws/scans/{id}`, authorised subscribers only | Events: `scan.progress`, `scan.finding`, `scan.status`, `scan.warning` |
| Worker ↔ Target | HTTP/1.1 and HTTP/2 over TCP/TLS | Rate-limited and scope-enforced (FR-8.1) |
| API ↔ Database / Queue | PostgreSQL wire protocol over TLS; Redis protocol, authenticated | |

## 3.3 Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-PERF-1 | The API shall respond to 95% of read requests within 300 ms (99% within 800 ms) under 50 concurrent users; the dashboard shall be interactive within 3 s on a 10 Mbps connection; findings queries shall return within 500 ms for 10,000 historical findings. |
| NFR-PERF-2 | A Standard-profile scan of a 200-page target shall complete within 15 minutes at the default rate limit; a scan worker shall not exceed 1 GB resident memory; a 500-finding PDF report shall generate within 60 s. |
| NFR-SEC-1 | All client–server communication shall use TLS 1.2+ with HSTS (`max-age` ≥ 1 year); the app shall set a restrictive CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy`; session cookies shall be `HttpOnly`, `Secure`, `SameSite=Strict`. |
| NFR-SEC-2 | All input crossing a trust boundary shall be validated against an explicit schema; all database access shall use parameterised queries or an ORM; every endpoint shall enforce object-level authorisation verifying the principal's organisation owns the resource. |
| NFR-SEC-3 | Retained evidence shall be encrypted at rest; secrets shall come from environment configuration or a secret manager, never version control; dependency scanning shall fail any build introducing a Critical or High advisory; the system shall pass a Standard-profile scan of itself with no finding of `HIGH` or above. |
| NFR-SEC-4 | Authentication, registration, target verification, and scan initiation endpoints shall be rate-limited; error responses shall not disclose stack traces, framework versions, internal hostnames, or SQL fragments. |
| NFR-USE-1 | A first-time user shall be able to register a target, verify ownership, and complete a scan using only in-product guidance; every finding shall be explained in plain language before technical detail, with evidence progressively disclosed. |
| NFR-USE-2 | The interface shall conform to WCAG 2.1 AA, be usable at 360–2560 px viewport widths, require explicit confirmation naming the resource for every destructive action, and present error messages that state what failed and what the user can do about it. |
| NFR-REL-1 | No scan job shall be lost to a worker crash (jobs are redelivered and resumed); the system shall recover from transient database/queue unavailability of up to 60 s without data loss; failure of an external dependency shall degrade only the affected feature; the database shall be backed up daily (RPO 24 h, RTO 4 h). |
| NFR-MAINT-1 | Automated test coverage shall be ≥ 80% of statements for the scan engine and API, with every detector tested against a purpose-built vulnerable fixture application; linting and type-checking shall pass with zero errors as a condition of merge; the system shall emit structured logs with correlation IDs across API, queue, and worker; schema changes shall use versioned, reversible migrations. |
| NFR-SCAL-1 | The API tier shall be stateless and horizontally scalable; scan throughput shall scale by adding workers without code changes; the system shall sustain 20 concurrent scans on 4 workers. |
| NFR-PORT-1 | The complete system shall run via a single container-orchestration definition on Linux, macOS, and Windows (WSL2) hosts; the dashboard shall support the current and previous major versions of Chrome, Firefox, Safari, and Edge; the engine shall handle HTTP/1.1 and HTTP/2 and correctly process declared response encodings. |

**Detector quality targets:** against the project's benchmark fixture suite (every vulnerability deliberately introduced and catalogued as ground truth), the system shall detect ≥ 85% of in-catalogue vulnerabilities and report ≤ 15% false positives among `HIGH`/`CRITICAL` findings. Results shall be measured and published in the project report, including where they fall short.

## 3.4 Design Constraints

| ID | Constraint |
|---|---|
| DC-1 | TypeScript in strict mode for all first-party code, client and server. |
| DC-2 | Server framework: NestJS. Client framework: React with Vite. |
| DC-3 | Persistence: PostgreSQL accessed through the Prisma ORM. |
| DC-4 | Asynchronous work queued through BullMQ backed by Redis. |
| DC-5 | JavaScript rendering via Playwright with headless Chromium. |
| DC-6 | REST API with an OpenAPI 3.1 specification generated from the implementation; WebSocket transport for live dashboard updates. |
| DC-7 | Packaging as containers with a single orchestration definition for local and demonstration deployment. |
| DC-8 | Detectors declare their metadata (identifier, version, category, CWE, default severity, passive/active) as data; declarative detectors are authored in YAML, validated against a published JSON Schema, and every template-issued request passes through the Scope Guard (FR-8.1) — no template may bypass scope, rate-limit, or blocklist enforcement. |
| DC-9 | Findings shall be immutable once written, with triage state recorded as separate versioned associations; audit records shall be append-only at the database privilege level; evidence shall be stored separately from finding metadata to permit independent purging; all timestamps stored in UTC. |

---

# 4. Appendices

## Appendix A — Detector Catalogue

### A.1 Passive Detectors

| ID | Detector | CWE | OWASP 2021 | Default severity | Priority |
|---|---|---|---|---|---|
| P-01 | Missing or weak Content-Security-Policy | CWE-693 | A05 | Medium | M |
| P-02 | Missing HTTP Strict-Transport-Security | CWE-319 | A02 | Medium | M |
| P-03 | Missing `X-Content-Type-Options: nosniff` | CWE-693 | A05 | Low | M |
| P-04 | Missing or permissive frame-ancestors / X-Frame-Options | CWE-1021 | A05 | Medium | M |
| P-05 | Missing or overly permissive Referrer-Policy | CWE-200 | A01 | Low | M |
| P-06 | Missing Permissions-Policy | CWE-693 | A05 | Info | S |
| P-07 | Cookie without `Secure` attribute | CWE-614 | A05 | Medium | M |
| P-08 | Cookie without `HttpOnly` attribute | CWE-1004 | A05 | Medium | M |
| P-09 | Cookie without or with weak `SameSite` | CWE-1275 | A01 | Low | M |
| P-10 | Cookie scoped too broadly (parent domain) | CWE-565 | A01 | Low | S |
| P-11 | Deprecated TLS protocol offered (TLS 1.0 / 1.1 / SSLv3) | CWE-327 | A02 | High | M |
| P-12 | Weak cipher suite offered | CWE-327 | A02 | High | M |
| P-13 | Certificate expired, not yet valid, or expiring within 30 days | CWE-324 | A02 | High | M |
| P-14 | Certificate hostname mismatch | CWE-297 | A07 | High | M |
| P-15 | Self-signed or untrusted certificate chain | CWE-295 | A07 | High | M |
| P-16 | Weak certificate signature algorithm or key size | CWE-327 | A02 | Medium | S |
| P-17 | Server / framework version disclosure in headers | CWE-200 | A05 | Low | M |
| P-18 | Technology and component fingerprinting | — | — | Info | M |
| P-19 | Known-vulnerable component version (OSV/CVE correlation) | CWE-1104 | A06 | Varies by CVE | S |
| P-20 | Verbose error page or stack trace disclosure | CWE-209 | A05 | Medium | M |
| P-21 | Exposed version control directory (`.git`, `.svn`, `.hg`) | CWE-527 | A05 | Critical | M |
| P-22 | Exposed environment or configuration file (`.env`, `web.config`) | CWE-538 | A05 | Critical | M |
| P-23 | Directory listing enabled | CWE-548 | A05 | Medium | M |
| P-24 | Backup or temporary file exposure (`.bak`, `~`, `.old`) | CWE-530 | A05 | High | S |
| P-25 | Mixed active content on HTTPS page | CWE-311 | A02 | Medium | M |
| P-26 | External script without Subresource Integrity | CWE-353 | A08 | Low | S |
| P-27 | Secret or credential pattern in response body | CWE-540 | A05 | Critical | M |
| P-28 | Email or personal data disclosure in response | CWE-200 | A01 | Low | S |
| P-29 | Sensitive page cacheable by intermediaries | CWE-525 | A04 | Low | S |
| P-30 | Missing or malformed `security.txt` (RFC 9116) | — | — | Info | C |
| P-31 | Autocomplete enabled on password or sensitive field | CWE-522 | A07 | Low | C |

### A.2 Safe Active Detectors

All detectors in this table are restricted by FR-5.4: idempotent methods, benign marker payloads, no data modification, no command execution, no file writing.

| ID | Detector | Technique | CWE | OWASP 2021 | Default severity | Priority |
|---|---|---|---|---|---|---|
| A-01 | Reflected Cross-Site Scripting | Inject a unique benign marker; confirm unencoded reflection in HTML, attribute, or script context | CWE-79 | A03 | High | M |
| A-02 | SQL Injection (error-based) | Inject syntax-breaking characters; match database error signatures | CWE-89 | A03 | Critical | M |
| A-03 | SQL Injection (boolean-based) | Compare responses to logically true and false conditions | CWE-89 | A03 | Critical | S |
| A-04 | Open Redirect | Redirect parameter pointed at a project-controlled sentinel host; confirm `Location` | CWE-601 | A01 | Medium | M |
| A-05 | CORS misconfiguration | Send varied `Origin` values; detect reflection, `null` acceptance, wildcard with credentials | CWE-942 | A05 | High | M |
| A-06 | Clickjacking | Confirm the page is framable and lacks frame-ancestor restrictions | CWE-1021 | A05 | Medium | M |
| A-07 | Dangerous HTTP methods enabled | `OPTIONS` enumeration; verify `TRACE`/`PUT`/`DELETE` availability without invoking them destructively | CWE-650 | A05 | Medium | M |
| A-08 | Host header injection | Supply an alternate `Host`; detect unvalidated reflection into links or redirects | CWE-644 | A03 | Medium | S |
| A-09 | Sensitive file and directory enumeration | Bounded, rate-limited wordlist of common administrative and backup paths | CWE-538 | A05 | Varies | M |
| A-10 | Missing anti-CSRF token on state-changing form | Structural analysis of forms for a token field and its unpredictability | CWE-352 | A01 | Medium | S |
| A-11 | Path traversal (read-only probe) | Traversal sequences on file parameters; match well-known read-only file signatures | CWE-22 | A01 | High | S |
| A-12 | Server-side template injection (detection only) | Arithmetic marker expression; confirm evaluation without further exploitation | CWE-1336 | A03 | High | C |
| A-13 | Unauthenticated access to administrative interface | Request known admin paths; classify response as authenticated-gate or open | CWE-306 | A01 | High | S |
| A-14 | Improper HTTPS redirection | Verify that the plaintext origin redirects to HTTPS | CWE-319 | A02 | Medium | M |

### A.3 Explicitly Excluded Techniques

| Technique | Reason for exclusion |
|---|---|
| Time-based blind SQL injection | Indistinguishable from network variance within the response budget; high false-positive rate |
| OS command injection | Cannot be probed without risk of execution on the target |
| File upload exploitation | Necessarily writes to the target, violating C-1 |
| XML External Entity with outbound resolution | Constitutes SSRF against third parties |
| Server-side request forgery exploitation | Would make the target attack other systems |
| Insecure deserialisation exploitation | Cannot be probed without risk of code execution |
| Brute force / credential stuffing | Attacks accounts rather than assessing configuration |
| Denial of service, stress, resource exhaustion | Directly harms the target |

## Appendix B — Severity and Confidence Model

Severity derives from the CVSS v3.1 base score:

| Severity | CVSS base score |
|---|---|
| CRITICAL | 9.0 – 10.0 |
| HIGH | 7.0 – 8.9 |
| MEDIUM | 4.0 – 6.9 |
| LOW | 0.1 – 3.9 |
| INFO | 0.0 |

Confidence is reported alongside, and independently of, severity:

| Confidence | Meaning |
|---|---|
| `CONFIRMED` | The scanner directly observed the vulnerable behaviour (e.g. its marker reflected unencoded into an executable context). |
| `FIRM` | Strong indirect evidence, but the vulnerable behaviour was not directly triggered. |
| `TENTATIVE` | Pattern or version match consistent with the weakness; independent verification required. |

Severity shall **not** be silently downgraded on the basis of low confidence. Both values are reported, and the user decides.

## Appendix C — Role-Permission Matrix

| Capability | ADMIN | ANALYST | DEVELOPER | VIEWER |
|---|:--:|:--:|:--:|:--:|
| Register / verify targets | ✔ | ✔ | ✖ | ✖ |
| Configure scope | ✔ | ✔ | ✖ | ✖ |
| Initiate scan | ✔ | ✔ | ✔ | ✖ |
| Configure scan beyond defaults | ✔ | ✔ | ✖ | ✖ |
| Pause / cancel own scan | ✔ | ✔ | ✔ | ✖ |
| View findings | ✔ | ✔ | ✔ | ✔ |
| View raw evidence | ✔ | ✔ | ✔ | ✖ |
| Triage findings | ✔ | ✔ | ✔ | ✖ |
| Export technical report | ✔ | ✔ | ✔ | ✖ |
| Export executive report | ✔ | ✔ | ✔ | ✔ |
| Delete target / scan | ✔ | ✔ | ✖ | ✖ |
| Manage users and quotas | ✔ | ✖ | ✖ | ✖ |
| Edit blocklist | ✔ | ✖ | ✖ | ✖ |
| View audit log | ✔ | ✖ | ✖ | ✖ |
| Activate kill switch | ✔ | ✖ | ✖ | ✖ |

## Appendix D — Deferred Features

Recognised as valuable but outside this release; the architecture shall not preclude them.

- **Authenticated scanning** (session, form login, OAuth) — the single largest coverage limitation of this release; credentialed scanning typically finds several times more issues because most attack surface lies behind a login. Reports state this limitation per FR-7.3.
- **API-specific scanning** driven by OpenAPI or GraphQL introspection.
- **CI/CD integration** with a build-failing gate (SARIF output, FR-7.1, already satisfies the data contract).
- **Issue-tracker integration** (Jira, GitHub Issues).
- **Distributed scanning** from multiple geographic egress points.
- **Machine-learning-assisted false-positive suppression** (triage decisions already persist as labelled data).
- **Single sign-on** (SAML / OIDC).
- **Network-agent deployment** for internal targets.

---

## Version History

| Version | Date | Description |
|---|---|---|
| 0.1 | 2026-07-18 | Initial draft — scope and overall description |
| 0.2 | 2026-07-25 | Functional requirements, detector catalogue |
| 1.0 | 2026-08-01 | Non-functional requirements, data model; baselined |
| 1.1 | 2026-08-02 | Positioning vs infrastructure VA; declarative detectors; evidence re-evaluation; EPSS (full text archived at `docs/archive/SRS-v1.1-detailed.md`) |

---

*End of document.*
