# Software Requirements Specification

> **Historical archive — non-authoritative.** This 2 August 2026 detailed
> draft is retained for reference only. The current requirements authority is
> [SRS v1.2](../srs/SRS.md); this file must not override it.

## Website Vulnerability Scanner

**Version 1.0**

Prepared in accordance with IEEE Std 830-1998, *Recommended Practice for Software Requirements Specifications*.

---

### Document Control

| Field | Value |
|---|---|
| Document title | Software Requirements Specification — Website Vulnerability Scanner |
| Version | 1.1 |
| Status | Historical draft — superseded |
| Date | 2 August 2026 |
| Prepared by | Project Team |
| Standard | IEEE Std 830-1998 |

### Revision History

| Version | Date | Author | Description |
|---|---|---|---|
| 0.1 | 2026-07-18 | Project Team | Initial draft — scope and overall description |
| 0.2 | 2026-07-25 | Project Team | Functional requirements, detector catalogue |
| 1.0 | 2026-08-01 | Project Team | Non-functional requirements, data model, baselined |
| 1.1 | 2026-08-02 | Project Team | Added §2.1.4 positioning against infrastructure VA products; declarative detector architecture (FR-5.2.1–5.2.4, DC-10, DC-11); evidence re-evaluation (FR-5.11–5.13); EPSS enrichment (FR-5.8.1) |

### Approvals

| Role | Name | Signature | Date |
|---|---|---|---|
| Project Guide / Supervisor | | | |
| Project Coordinator | | | |
| Team Lead | | | |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Overall Description](#2-overall-description)
3. [Specific Requirements](#3-specific-requirements)
4. [Use Case Specifications](#4-use-case-specifications)
5. [Data Model](#5-data-model)
6. [External Interface Specifications](#6-external-interface-specifications)
7. [Verification and Validation](#7-verification-and-validation)
8. [Appendices](#8-appendices)

---

# 1. Introduction

## 1.1 Purpose

This Software Requirements Specification (SRS) defines the functional and non-functional requirements for the **Website Vulnerability Scanner (WVS)**, a web-based application that performs automated security assessment of publicly reachable web applications and presents the results through an interactive dashboard.

The document is intended for:

- **Project supervisors and examiners**, as the authoritative statement of what the system is required to do and the basis against which the delivered system is evaluated.
- **The development team**, as the input to architectural design, implementation, and test planning.
- **Future maintainers**, as the record of intent behind design decisions.

This SRS describes *what* the system shall do. It deliberately does not prescribe *how* each requirement is to be implemented, except where an implementation constraint is itself a requirement (see [Section 3.6](#36-design-constraints)).

## 1.2 Scope

### 1.2.1 Product Identification

The software product is named **Website Vulnerability Scanner (WVS)**.

### 1.2.2 What the Product Does

WVS accepts a target web application identified by URL, verifies that the requesting user is authorised to test that target, crawls the target to discover its reachable surface, executes a catalogue of vulnerability detectors against that surface, and produces a severity-ranked set of findings with supporting evidence and remediation guidance. Results are viewable in real time through a browser dashboard and exportable as PDF, HTML, JSON, CSV, and SARIF reports.

### 1.2.3 What the Product Does Not Do

WVS is a **detection** tool, not an exploitation tool. The following are explicitly outside its scope:

| Excluded capability | Rationale |
|---|---|
| Exploitation of discovered vulnerabilities (shell access, data extraction, privilege escalation) | The product's purpose is assessment, not intrusion. |
| Authenticated scanning behind a login session | Deferred to a future release; substantially increases scope and risk (see [8.3](#83-deferred-requirements)). |
| Denial-of-service, stress, or load testing | Would damage targets and cannot be performed safely. |
| Credential brute-forcing or password spraying | Attacks accounts rather than assessing configuration. |
| Blind and time-based injection techniques | Unreliable within the response-time budget and indistinguishable from network jitter. |
| Network-layer scanning of non-web ports | Out of the "website" problem domain. |
| Automated remediation or patching of the target | The product reports; humans remediate. |
| Scanning of native mobile applications or desktop software | Out of the web problem domain. |

### 1.2.4 Objectives and Benefits

| # | Objective |
|---|---|
| OBJ-1 | Reduce the manual effort required to perform a baseline security assessment of a web application from hours to minutes. |
| OBJ-2 | Produce findings that are *actionable*: each accompanied by evidence, severity, and specific remediation guidance. |
| OBJ-3 | Guarantee that scanning is non-destructive — a scanned application shall remain fully functional and its data unmodified. |
| OBJ-4 | Enforce, in software, that users may only scan targets they have demonstrated authority over. |
| OBJ-5 | Present results at a level of clarity usable both by developers fixing issues and by non-specialists reviewing posture. |

### 1.2.5 Legal and Ethical Position

Unauthorised scanning of computer systems is a criminal offence in most jurisdictions, including under the Information Technology Act 2000 (India), the Computer Fraud and Abuse Act (United States), and the Computer Misuse Act 1990 (United Kingdom). WVS is designed for use **only** against targets the user owns or has written permission to test. The authorisation controls specified in [Section 3.2.2](#322-target-management-and-authorisation-fr-2) are mandatory functional requirements, not optional features, and shall not be made bypassable through configuration.

## 1.3 Definitions, Acronyms, and Abbreviations

### 1.3.1 Domain Terms

| Term | Definition |
|---|---|
| **Target** | A web application, identified by an origin (scheme + host + port), that has been registered in the system for scanning. |
| **Scan** | A single bounded execution of the scan engine against one target, producing zero or more findings. |
| **Detector** | A self-contained module implementing the logic for identifying one class of vulnerability or misconfiguration. |
| **Finding** | A single instance of a detected issue, comprising a detector identifier, a location, evidence, a severity, and remediation guidance. |
| **Evidence** | The concrete request/response data that substantiates a finding, retained so a human can independently verify it. |
| **Crawl** | The discovery phase in which the scanner enumerates reachable URLs, forms, and parameters within the defined scope. |
| **Scope** | The set of rules determining which URLs a scan may and may not request. |
| **Passive check** | A detector that draws conclusions only from traffic the scanner would generate anyway; it sends no crafted payloads. |
| **Safe active check** | A detector that sends crafted but non-destructive requests, restricted to idempotent methods and benign payloads. |
| **False positive** | A reported finding that does not represent a real weakness in the target. |
| **Ownership verification** | The process by which a user demonstrates administrative control of a target before scanning is permitted. |

### 1.3.2 Acronyms

| Acronym | Expansion |
|---|---|
| API | Application Programming Interface |
| CORS | Cross-Origin Resource Sharing |
| CSP | Content Security Policy |
| CSRF | Cross-Site Request Forgery |
| CVE | Common Vulnerabilities and Exposures |
| CVSS | Common Vulnerability Scoring System |
| CWE | Common Weakness Enumeration |
| DAST | Dynamic Application Security Testing |
| DOM | Document Object Model |
| EPSS | Exploit Prediction Scoring System |
| HSTS | HTTP Strict Transport Security |
| JWT | JSON Web Token |
| ORM | Object-Relational Mapper |
| OSV | Open Source Vulnerabilities (database) |
| OWASP | Open Worldwide Application Security Project |
| RBAC | Role-Based Access Control |
| SARIF | Static Analysis Results Interchange Format |
| SQLi | SQL Injection |
| SRI | Subresource Integrity |
| SSRF | Server-Side Request Forgery |
| TLS | Transport Layer Security |
| VA | Vulnerability Assessment |
| WVS | Website Vulnerability Scanner (this product) |
| XSS | Cross-Site Scripting |
| YAML | YAML Ain't Markup Language |

### 1.3.3 Requirement Notation

Requirements are identified as follows:

- `FR-n.m` — Functional Requirement
- `NFR-<CAT>-n` — Non-Functional Requirement, where `<CAT>` is one of PERF, SEC, USE, REL, MAINT, PORT, SCAL, COMP
- `DC-n` — Design Constraint
- `UC-n` — Use Case

The keywords **shall** (mandatory), **should** (recommended), and **may** (optional) are used per RFC 2119.

Each functional requirement carries a priority:

| Priority | Meaning |
|---|---|
| **M** (Must) | Required for the system to be considered complete. Absence is a project failure. |
| **S** (Should) | Important; omission requires documented justification. |
| **C** (Could) | Desirable; implemented if schedule permits. |

## 1.4 References

| # | Reference |
|---|---|
| R1 | IEEE Std 830-1998, *IEEE Recommended Practice for Software Requirements Specifications*. |
| R2 | OWASP Top 10:2021 — The Ten Most Critical Web Application Security Risks. |
| R3 | OWASP Web Security Testing Guide (WSTG), v4.2. |
| R4 | OWASP Application Security Verification Standard (ASVS), v4.0.3. |
| R5 | FIRST, *Common Vulnerability Scoring System v3.1: Specification Document*. |
| R6 | MITRE, *Common Weakness Enumeration (CWE)*, v4.x. |
| R7 | OASIS, *Static Analysis Results Interchange Format (SARIF) Version 2.1.0*. |
| R8 | RFC 9110, *HTTP Semantics*; RFC 9111, *HTTP Caching*. |
| R9 | RFC 6797, *HTTP Strict Transport Security (HSTS)*. |
| R10 | RFC 6265bis, *Cookies: HTTP State Management Mechanism*. |
| R11 | RFC 8446, *The Transport Layer Security (TLS) Protocol Version 1.3*. |
| R12 | RFC 9116, *A File Format to Aid in Security Vulnerability Disclosure* (security.txt). |
| R13 | RFC 9309, *Robots Exclusion Protocol*. |
| R14 | W3C, *Content Security Policy Level 3*. |
| R15 | Open Source Vulnerabilities (OSV) database schema and API. |
| R16 | FIRST, *Exploit Prediction Scoring System (EPSS) Model and API Specification*. |
| R17 | RFC 9457, *Problem Details for HTTP APIs*. |

## 1.5 Overview of the Document

- **Section 2** gives a non-technical overall description: the product's context, its principal functions, its users, and the constraints and assumptions under which it operates.
- **Section 3** gives the detailed, numbered, testable requirements — the contractual core of this document.
- **Section 4** expands the principal requirements into use case specifications with flows and exception handling.
- **Section 5** defines the persistent data model.
- **Section 6** specifies the external interfaces.
- **Section 7** defines how each requirement class is to be verified.
- **Section 8** contains appendices: the detector catalogue, severity model, deferred requirements, and traceability matrix.

---

# 2. Overall Description

## 2.1 Product Perspective

WVS is a **new, self-contained product**. It is not a replacement for, nor a component of, an existing system. It does, however, operate within an ecosystem of external services and is architecturally decomposed into cooperating subsystems.

### 2.1.1 System Context

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
              │  (external)      │   │ Intel (OSV/CVE)  │
              └──────────────────┘   └──────────────────┘
```

### 2.1.2 Subsystem Responsibilities

| Subsystem | Responsibility |
|---|---|
| **Web Dashboard** | Single-page application. Authentication, target management, scan control, live progress, finding triage, report export. |
| **Application API** | Stateless HTTP API. Request validation, authentication and authorisation, persistence orchestration, job enqueueing, report generation. |
| **Job Queue** | Durable work queue decoupling scan requests from scan execution. Supports retry, priority, and cancellation. |
| **Scan Engine Workers** | Horizontally scalable processes that consume scan jobs and execute the crawl and detection pipeline. |
| **Scope Guard** | The safety kernel. Every outbound request passes through it; it enforces authorisation, scope rules, rate limits, and network-level blocks. |
| **Database** | Durable store for users, targets, scans, findings, evidence, and audit records. |
| **Vulnerability Intelligence** | External advisory data (OSV/CVE) used to map detected component versions to known vulnerabilities. |

### 2.1.3 Interfaces to Existing Systems

WVS depends on the following external systems, all of which are third-party and outside the project's control:

| External system | Purpose | Failure behaviour |
|---|---|---|
| OSV / CVE advisory API | Map fingerprinted component versions to known CVEs | Scan proceeds; component-CVE findings suppressed and the degradation is recorded on the scan |
| SMTP relay | Delivery of verification and notification email | Queued for retry; account creation not blocked |
| Public DNS resolvers | Target resolution and TXT-record ownership verification | Scan fails with a clear diagnostic |

### 2.1.4 Related Systems and Positioning

WVS belongs to the **Dynamic Application Security Testing (DAST)** category. It is frequently confused with network and infrastructure vulnerability assessment products such as Tenable Nessus, Qualys, Rapid7 Nexpose, and OpenVAS. The distinction is fundamental and determines the entire architecture of this system.

| Dimension | Infrastructure VA (e.g. Nessus) | WVS (this product) |
|---|---|---|
| Category | Network / infrastructure vulnerability assessment | Web application dynamic security testing |
| Unit of assessment | IP address, host, subnet | URL / origin |
| Discovery method | Port enumeration, then service fingerprinting | HTTP crawl, then form and parameter enumeration |
| Central question | *What software is installed, and which published CVEs affect it?* | *Does this application's own code mishandle untrusted input?* |
| Knowledge source | Curated advisory feed mapped to detection plugins | Behavioural probes against observed application response |
| Class of defect found | Known vulnerabilities in third-party software | Previously unknown defects in first-party code |
| **Delivery model** | **Installed software, operated inside the customer's own network** | **Multi-tenant hosted web application, publicly reachable** |
| Comparable products | Qualys, Rapid7 Nexpose, OpenVAS | OWASP ZAP, Burp Suite, Acunetix, Nuclei |

Two consequences follow, and both are load-bearing for this specification.

**First, the categories are complementary rather than competing.** An injection defect in bespoke application code has no CVE identifier and never will; a signature-and-advisory approach is structurally incapable of detecting it. Conversely, WVS does not enumerate operating system patch levels or non-web network services. A complete security programme uses both. The overlap between the two categories is confined to transport and configuration checks — detectors P-11 through P-19 and P-21 through P-24 of [Appendix 8.1](#811-passive-detectors) — while the entire active catalogue at [8.1.2](#812-safe-active-detectors) lies outside the reach of infrastructure scanners.

**Second, the delivery model is the reason this specification treats authorisation as a mandatory safety kernel rather than a feature.** Installed scanners can devolve authorisation to the operator, because the operator owns both the scanner and the network it runs in. WVS cannot: it is a publicly reachable service that any visitor may register for, and it originates its own outbound traffic. Absent enforced authorisation, the product would constitute an anonymous, internet-facing attack platform. This is the direct justification for `FR-2.3` (ownership verification), `FR-2.5` and `FR-2.6` (address and host blocking), `FR-8.1` (Scope Guard), and `FR-8.2` (DNS-rebinding protection) being classified **Must**, and for constraint `C-2` prohibiting any configuration that disables them.

## 2.2 Product Functions

At the highest level, WVS provides eight function groups. Each is expanded into numbered requirements in [Section 3.2](#32-functional-requirements).

| Group | Summary |
|---|---|
| **F1 — Account and Access Management** | Registration, authentication, session management, role-based authorisation, organisation-scoped data isolation. |
| **F2 — Target Management and Authorisation** | Registration of targets, mandatory proof of ownership, scope definition, target lifecycle. |
| **F3 — Scan Configuration and Execution** | Scan profiles, scheduling, queueing, execution, live progress, pause/resume/abort. |
| **F4 — Discovery (Crawling)** | Scope-bounded enumeration of URLs, forms, parameters, and client-side resources, including JavaScript-rendered content. |
| **F5 — Vulnerability Detection** | Execution of the passive and safe-active detector catalogue against discovered surface. |
| **F6 — Findings Management** | Normalisation, deduplication, severity assignment, evidence retention, triage workflow, historical comparison. |
| **F7 — Reporting and Export** | Report generation in PDF, HTML, JSON, CSV, and SARIF; report templates for technical and summary audiences. |
| **F8 — Safety, Auditing, and Administration** | Rate limiting, blocklists, SSRF protection, kill switch, immutable audit log, system administration. |

## 2.3 User Characteristics

| Class | Technical level | Frequency of use | Primary need | Role |
|---|---|---|---|---|
| **Security Analyst** | High — understands OWASP categories, HTTP semantics, and exploitation concepts | Daily | Full scan control, raw evidence, low false-positive rate, triage workflow | `ANALYST` |
| **Developer** | Medium — understands web development, limited security specialism | Weekly | Clear explanations, precise remediation guidance, SARIF export into existing tooling | `DEVELOPER` |
| **Viewer / Stakeholder** | Low — non-technical | Monthly | Posture summary, trend over time, exportable PDF | `VIEWER` |
| **System Administrator** | High — operates the WVS deployment itself | As needed | User management, quota configuration, audit review, system health | `ADMIN` |

The dashboard shall accommodate this spread by presenting a layered view: a plain-language summary by default, with technical evidence available on demand (see `NFR-USE-3`).

## 2.4 Constraints

| # | Constraint |
|---|---|
| C-1 | The scan engine shall never issue a request that mutates target state. Only `GET`, `HEAD`, and `OPTIONS` are permitted by default; `POST` is permitted only against forms explicitly marked safe by the user, and never with destructive payloads. |
| C-2 | Scanning shall be permitted only against targets whose ownership has been verified through the mechanisms in `FR-2.3`. There shall be no configuration option that disables this. |
| C-3 | The system shall be developed within a single academic term by a student team, constraining total effort and ruling out capabilities requiring sustained maintenance (e.g. a self-maintained exploit database). |
| C-4 | The system shall be deployable on commodity hardware — a single machine with 8 GB RAM shall run the full stack for demonstration purposes. |
| C-5 | All third-party dependencies shall carry OSI-approved licences compatible with academic distribution. No commercially licensed scanning engine shall be embedded. |
| C-6 | The implementation language shall be TypeScript across both client and server tiers (see `DC-1`). |
| C-7 | Personal data collected shall be limited to what is necessary for authentication and audit; no target content shall be retained beyond the evidence retention window defined in `FR-6.4`. |

## 2.5 Assumptions and Dependencies

### 2.5.1 Assumptions

| # | Assumption | Impact if false |
|---|---|---|
| A-1 | Target applications are reachable over the public internet from the deployment environment. | Targets behind VPNs or firewalls cannot be scanned; a network-agent deployment mode would be required. |
| A-2 | Users have administrative control of the targets they register, sufficient to publish a DNS TXT record or a file under `/.well-known/`. | Ownership verification fails; the target cannot be scanned. |
| A-3 | Targets respond to well-formed HTTP requests without aggressive bot mitigation. | WAF or bot-detection interference produces incomplete crawls and false negatives; the scan shall report reduced confidence (`FR-4.6`). |
| A-4 | Public vulnerability advisory data remains freely accessible under its current terms. | Component-CVE correlation is lost; other detectors are unaffected. |
| A-5 | Targets are conventional HTTP/HTTPS applications, not WebSocket-only or gRPC-only services. | Discovery coverage is materially reduced for such targets. |

### 2.5.2 Dependencies

| # | Dependency | Type |
|---|---|---|
| D-1 | Node.js LTS runtime (v22 or later) | Runtime |
| D-2 | PostgreSQL 16 or later | Runtime |
| D-3 | Redis 7 or later | Runtime |
| D-4 | Headless Chromium (via Playwright) for JavaScript rendering | Runtime |
| D-5 | OSV advisory API | External service |
| D-6 | SMTP relay for transactional email | External service |
| D-7 | A registered domain and TLS certificate for the WVS deployment itself | Deployment |

---

# 3. Specific Requirements

## 3.1 Requirement Organisation

Requirements are grouped by function group (F1–F8, per [Section 2.2](#22-product-functions)). Every requirement is uniquely identified, assigned a priority, and stated so as to be independently verifiable.

## 3.2 Functional Requirements

### 3.2.1 Account and Access Management (FR-1)

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | The system shall allow a visitor to register an account using an email address and a password. Registration shall be rejected if the email is already in use. | M |
| FR-1.2 | The system shall require email address confirmation before the account may register a target or initiate a scan. Confirmation links shall expire 24 hours after issue. | M |
| FR-1.3 | The system shall enforce a password policy of at least 12 characters, and shall reject passwords appearing in a known-breached-password corpus. | M |
| FR-1.4 | The system shall store passwords only as salted hashes produced by a memory-hard key derivation function (Argon2id). Plaintext or reversibly encrypted passwords shall not be stored. | M |
| FR-1.5 | The system shall authenticate users by email and password, issuing a short-lived access token (≤ 15 minutes) and a longer-lived refresh token (≤ 7 days). | M |
| FR-1.6 | The system shall lock an account for 15 minutes after 5 consecutive failed authentication attempts, and shall notify the account holder by email. | M |
| FR-1.7 | The system shall allow a user to terminate any or all of their active sessions. | S |
| FR-1.8 | The system shall support the roles `ADMIN`, `ANALYST`, `DEVELOPER`, and `VIEWER`, with permissions as defined in [Appendix 8.2](#82-role-permission-matrix). | M |
| FR-1.9 | The system shall associate every user with exactly one organisation, and shall ensure that no user can read or modify targets, scans, findings, or reports belonging to another organisation. | M |
| FR-1.10 | The system shall allow a user to enable time-based one-time-password (TOTP) two-factor authentication. | C |
| FR-1.11 | The system shall allow a user to request account deletion, which shall remove personal data and anonymise retained audit records within 30 days. | S |

### 3.2.2 Target Management and Authorisation (FR-2)

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | The system shall allow a user with role `ANALYST` or above to register a target by supplying an origin (scheme, host, optional port) and a human-readable label. | M |
| FR-2.2 | The system shall validate at registration that the supplied origin is syntactically well-formed, uses the `http` or `https` scheme, and resolves in public DNS. | M |
| FR-2.3 | The system shall require the user to prove control of a target before any scan of that target may be initiated. It shall support at least two verification methods: (a) publication of a system-issued token as a DNS TXT record on the target domain; (b) publication of a system-issued token at `https://<host>/.well-known/wvs-verification.txt`. | M |
| FR-2.4 | The system shall re-verify target ownership at least every 90 days, and shall place a target in an unverified state — blocking further scans — if re-verification fails. | M |
| FR-2.5 | The system shall refuse to register, verify, or scan any target that resolves to a loopback address, a link-local address, an RFC 1918 private range, a carrier-grade NAT range, a cloud instance metadata endpoint, or any host on the system blocklist. | M |
| FR-2.6 | The system shall maintain an administrator-editable blocklist of hosts and domains that may never be registered as targets, pre-populated with government, financial, healthcare, and critical-infrastructure domains. | M |
| FR-2.7 | The system shall allow the user to define, per target, a scope comprising: in-scope host patterns, path include patterns, path exclude patterns, query parameters to leave untouched, and a maximum crawl depth. | M |
| FR-2.8 | The system shall require the user to affirmatively acknowledge, at target registration, that they are authorised to test the target. The acknowledgement, with timestamp and source IP, shall be recorded immutably. | M |
| FR-2.9 | The system shall allow a user to archive a target, which retains its historical scans and findings but prevents new scans. | S |
| FR-2.10 | The system shall allow a user to permanently delete a target and all associated scans, findings, and evidence. | S |

### 3.2.3 Scan Configuration and Execution (FR-3)

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | The system shall provide at least three built-in scan profiles: **Passive** (no crafted payloads), **Standard** (passive plus safe active checks), and **Thorough** (Standard with wider crawl limits and a larger enumeration wordlist). | M |
| FR-3.2 | The system shall allow a user to create a custom profile by selecting individual detectors from the catalogue in [Appendix 8.1](#81-detector-catalogue). | S |
| FR-3.3 | The system shall allow per-scan configuration of: maximum request rate (requests/second), maximum concurrent connections, maximum total requests, maximum crawl depth, maximum pages, request timeout, and custom request headers. | M |
| FR-3.4 | The system shall enqueue a requested scan and return control to the user immediately; scan execution shall be asynchronous. | M |
| FR-3.5 | The system shall report scan lifecycle state as one of `QUEUED`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED`, `CANCELLED`, or `ABORTED_SAFETY`. | M |
| FR-3.6 | The system shall stream live scan progress to the dashboard, updating at least every 2 seconds, comprising: current phase, pages crawled, requests issued, detectors completed, and findings discovered so far. | M |
| FR-3.7 | The system shall allow a user to pause, resume, and cancel a running scan. Cancellation shall halt all outbound requests within 5 seconds. | M |
| FR-3.8 | The system shall allow scheduling of recurring scans on a daily, weekly, or monthly cadence. | S |
| FR-3.9 | The system shall enforce a per-organisation quota on concurrent running scans and on scans per calendar day, configurable by an administrator. | M |
| FR-3.10 | The system shall resume an interrupted scan from its last checkpoint if a worker process fails, without re-crawling completed surface. | S |
| FR-3.11 | The system shall notify the requesting user by email and in-app notification upon scan completion or failure. | S |
| FR-3.12 | The system shall record, for every scan, the exact profile, detector versions, and configuration used, so that a historical scan's conditions are reconstructible. | M |

### 3.2.4 Discovery / Crawling (FR-4)

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | The system shall discover reachable URLs starting from the target origin by following in-scope hyperlinks, form actions, and resource references. | M |
| FR-4.2 | The system shall render JavaScript-driven pages in a headless browser so that client-side-generated links, routes, and API calls are discovered. | M |
| FR-4.3 | The system shall parse `robots.txt` and `sitemap.xml` for additional candidate URLs, and shall by default honour `robots.txt` exclusions. Honouring may be disabled only for targets whose ownership is verified, and the override shall be recorded in the audit log. | M |
| FR-4.4 | The system shall enumerate, for each discovered page, its forms with their methods, action URLs, and input fields, and its URL query parameters. | M |
| FR-4.5 | The system shall normalise and deduplicate discovered URLs, collapsing those that differ only in session identifiers, cache-busting parameters, or ordering of query parameters. | M |
| FR-4.6 | The system shall detect indicators of blocking — sustained `403`, `429`, or CAPTCHA-bearing responses — and shall mark affected scan results as reduced-confidence rather than reporting absence of findings as absence of vulnerabilities. | M |
| FR-4.7 | The system shall respect the configured crawl depth, page count, and total request ceilings, terminating discovery cleanly when any is reached and recording which limit bound the scan. | M |
| FR-4.8 | The system shall detect and avoid crawl traps, including infinitely recursive paths, calendar-style parameter spaces, and self-referential redirect chains. | S |
| FR-4.9 | The system shall record the discovered site structure and make it viewable in the dashboard as a navigable tree. | C |

### 3.2.5 Vulnerability Detection (FR-5)

| ID | Requirement | Priority |
|---|---|---|
| FR-5.1 | The system shall implement all detectors marked **M** in the catalogue at [Appendix 8.1](#81-detector-catalogue). | M |
| FR-5.2 | The system shall separate detection *knowledge* from detection *engine*, such that detectors can be added, disabled, or versioned without modification to scan engine code. | M |
| FR-5.2.1 | The system shall provide a declarative detector format in which a detector is expressed as data — specifying the request(s) to issue, the matching conditions to apply to the response, and the finding metadata to emit — and shall execute such detectors through a common template interpreter. | M |
| FR-5.2.2 | The system shall express as declarative templates every detector whose logic reduces to issuing requests and matching response patterns. Detectors requiring logic the template format cannot express — including transport-layer analysis (P-11 to P-16) and detectors coupled to crawler state (A-10) — shall be implemented as native modules conforming to the same registration interface. | M |
| FR-5.2.3 | The system shall validate declarative templates against a published schema at load time, and shall refuse to load a malformed template without affecting other detectors. | M |
| FR-5.2.4 | The system shall permit an administrator to load additional declarative templates without rebuilding or redeploying the application. | S |
| FR-5.3 | The system shall execute passive detectors against every in-scope response without issuing additional requests. | M |
| FR-5.4 | The system shall restrict active detectors to non-destructive, idempotent probes. Payloads shall be benign markers; no payload shall attempt data modification, data exfiltration, command execution, or file writing. | M |
| FR-5.5 | The system shall assign each finding a CVSS v3.1 base score and a derived severity of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, or `INFO`, per the model in [Appendix 8.4](#84-severity-model). | M |
| FR-5.6 | The system shall map each finding to its corresponding CWE identifier and OWASP Top 10:2021 category. | M |
| FR-5.7 | The system shall assign each finding a confidence level of `CONFIRMED`, `FIRM`, or `TENTATIVE`, reflecting the strength of the evidence. | M |
| FR-5.8 | The system shall correlate fingerprinted component versions against the OSV advisory database and raise a finding for each applicable known vulnerability. | S |
| FR-5.8.1 | The system shall, for findings carrying a CVE identifier, retrieve and display the EPSS exploitation-probability score alongside the CVSS severity, so that prioritisation reflects likelihood of exploitation and not solely theoretical impact. Findings without a CVE identifier shall display CVSS alone, and the absence of an EPSS score shall not be presented as low risk. | C |
| FR-5.9 | The system shall isolate detector failures: an exception in one detector shall be logged and shall not terminate the scan or affect other detectors. | M |
| FR-5.10 | The system shall halt the scan and transition it to `ABORTED_SAFETY` if it detects that its own traffic is degrading the target — sustained `5xx` responses or response times exceeding five times the observed baseline. | M |
| FR-5.11 | The system shall support re-evaluation of a completed scan by executing passive detectors against its retained evidence, without issuing any new request to the target, so that detectors added or corrected after a scan was run can yield findings against historical data. | S |
| FR-5.12 | The system shall mark findings produced by re-evaluation as such, recording the original scan date and the re-evaluation date distinctly, and shall exclude re-evaluation from scan quotas since it generates no target traffic. | S |
| FR-5.13 | The system shall restrict re-evaluation to scans whose evidence has not yet been purged under `FR-6.4`, and shall report clearly when re-evaluation is unavailable for that reason. | S |

### 3.2.6 Findings Management (FR-6)

| ID | Requirement | Priority |
|---|---|---|
| FR-6.1 | The system shall deduplicate findings within a scan such that the same weakness at the same location is reported once, with all affected instances listed as occurrences. | M |
| FR-6.2 | The system shall present, for every finding: title, description, severity, CVSS vector, confidence, CWE, OWASP category, affected location, evidence, and remediation guidance. | M |
| FR-6.3 | The system shall retain, as evidence, the sanitised HTTP request and response pair that substantiates each finding. | M |
| FR-6.4 | The system shall redact credentials, session tokens, and recognised personal data from retained evidence, and shall purge evidence after a configurable retention period defaulting to 90 days. | M |
| FR-6.5 | The system shall allow a user to set a finding's triage status to `OPEN`, `CONFIRMED`, `FALSE_POSITIVE`, `ACCEPTED_RISK`, or `RESOLVED`, with an optional justification note. | M |
| FR-6.6 | The system shall carry triage decisions forward across scans of the same target, so that a finding previously marked `FALSE_POSITIVE` or `ACCEPTED_RISK` is presented as such on rediscovery. | M |
| FR-6.7 | The system shall compare a completed scan against the previous scan of the same target and classify each finding as `NEW`, `PERSISTING`, or `RESOLVED`. | M |
| FR-6.8 | The system shall allow filtering and sorting of findings by severity, confidence, status, detector, OWASP category, and URL. | M |
| FR-6.9 | The system shall present a target's security posture over time as a trend of finding counts by severity per scan. | S |
| FR-6.10 | The system shall allow a user to assign a finding to another user in the same organisation. | C |

### 3.2.7 Reporting and Export (FR-7)

| ID | Requirement | Priority |
|---|---|---|
| FR-7.1 | The system shall generate a report for any completed scan in PDF, HTML, JSON, CSV, and SARIF v2.1.0 formats. | M |
| FR-7.2 | The system shall provide at least two report templates: an **Executive Summary** (posture overview, severity distribution, trend, no raw evidence) and a **Technical Report** (all findings with full evidence and remediation detail). | M |
| FR-7.3 | The system shall produce SARIF output conforming to the v2.1.0 schema such that it is consumable by GitHub code scanning without transformation. | S |
| FR-7.4 | The system shall allow the user to filter a report's contents by severity threshold and triage status before generation. | S |
| FR-7.5 | The system shall include in every report: target identity, scan timestamps, profile used, scope definition, detector versions, and any coverage limitations encountered. | M |
| FR-7.6 | The system shall generate reports asynchronously and notify the user when a report is ready for download. | S |
| FR-7.7 | The system shall allow generation of a time-limited shareable link to a report, expiring after a user-selected period not exceeding 30 days. | C |

### 3.2.8 Safety, Auditing, and Administration (FR-8)

| ID | Requirement | Priority |
|---|---|---|
| FR-8.1 | The system shall route every outbound scan request through a single Scope Guard component that enforces, in order: target verification status, scope rules, network blocklist, rate limit, and request ceiling. A request failing any check shall not be issued. | M |
| FR-8.2 | The system shall resolve target hostnames and validate the resolved IP address immediately before connection, rejecting private, loopback, link-local, and metadata addresses, so as to prevent DNS-rebinding-based SSRF against the scanner's own network. | M |
| FR-8.3 | The system shall apply a default outbound rate limit of 10 requests per second per target, configurable within an administrator-set ceiling. | M |
| FR-8.4 | The system shall provide an administrator kill switch that immediately halts all running scans system-wide. | M |
| FR-8.5 | The system shall maintain an append-only audit log recording: authentication events, target registration, ownership verification attempts and outcomes, authorisation acknowledgements, scan initiation and termination, configuration overrides, report exports, and administrative actions. Audit records shall not be editable or deletable through the application. | M |
| FR-8.6 | The system shall record, for every scan, the full list of URLs requested, so that a target owner can reconcile the scanner's traffic against their own server logs. | M |
| FR-8.7 | The system shall identify itself in every outbound request via a `User-Agent` header naming the product and providing a contact URL. | M |
| FR-8.8 | The system shall allow an administrator to view, suspend, and reactivate user accounts, and to adjust per-organisation quotas. | M |
| FR-8.9 | The system shall expose a health endpoint reporting the status of the API, database, queue, and worker pool. | S |
| FR-8.10 | The system shall allow an administrator to review the audit log with filtering by actor, action type, target, and time range. | S |

## 3.3 Non-Functional Requirements

### 3.3.1 Performance (NFR-PERF)

| ID | Requirement |
|---|---|
| NFR-PERF-1 | The API shall respond to 95% of read requests within 300 ms and 99% within 800 ms, measured under a load of 50 concurrent users. |
| NFR-PERF-2 | The dashboard shall reach interactive state within 3 seconds on a 10 Mbps connection. |
| NFR-PERF-3 | A Standard-profile scan of a target with 200 discoverable pages shall complete within 15 minutes at the default rate limit. |
| NFR-PERF-4 | Live scan progress shall reach the dashboard within 2 seconds of the underlying state change. |
| NFR-PERF-5 | A PDF report containing up to 500 findings shall be generated within 60 seconds. |
| NFR-PERF-6 | A single scan worker shall not exceed 1 GB of resident memory regardless of target size. |
| NFR-PERF-7 | Findings list queries shall return within 500 ms for a target holding up to 10,000 historical findings. |

### 3.3.2 Security (NFR-SEC)

The scanner is itself a high-value target: it holds evidence of vulnerabilities in third-party systems. Its own security posture is therefore a first-class requirement.

| ID | Requirement |
|---|---|
| NFR-SEC-1 | All network communication between client and server shall use TLS 1.2 or higher. Plaintext HTTP shall redirect to HTTPS and the application shall set HSTS with a minimum `max-age` of one year. |
| NFR-SEC-2 | The application shall set a restrictive Content-Security-Policy, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a restrictive `Permissions-Policy`. |
| NFR-SEC-3 | Session cookies shall be set with `HttpOnly`, `Secure`, and `SameSite=Strict`. |
| NFR-SEC-4 | All input crossing a trust boundary shall be validated against an explicit schema; requests failing validation shall be rejected before reaching business logic. |
| NFR-SEC-5 | All database access shall use parameterised queries or an ORM. String-concatenated SQL shall not appear in the codebase. |
| NFR-SEC-6 | Every API endpoint shall enforce authorisation at the object level, verifying that the authenticated principal's organisation owns the referenced resource. |
| NFR-SEC-7 | Retained evidence shall be encrypted at rest. |
| NFR-SEC-8 | Secrets shall be supplied through environment configuration or a secret manager, never committed to version control. |
| NFR-SEC-9 | The application shall apply rate limiting to authentication, registration, target verification, and scan initiation endpoints. |
| NFR-SEC-10 | Error responses shall not disclose stack traces, framework versions, internal hostnames, or SQL fragments. |
| NFR-SEC-11 | Dependencies shall be scanned for known vulnerabilities on every build; a build introducing a Critical or High advisory shall fail. |
| NFR-SEC-12 | The system shall itself pass a Standard-profile WVS scan with no finding of severity `HIGH` or above — the product shall be able to scan itself cleanly. |

### 3.3.3 Usability (NFR-USE)

| ID | Requirement |
|---|---|
| NFR-USE-1 | A first-time user shall be able to register a target, verify ownership, and complete a scan without consulting documentation beyond the in-product guidance. |
| NFR-USE-2 | Every finding shall be explained in plain language before any technical detail is presented, such that a non-specialist can understand the risk. |
| NFR-USE-3 | Technical evidence shall be available but progressively disclosed, so that the default view is not overwhelming to a `VIEWER`. |
| NFR-USE-4 | The interface shall conform to WCAG 2.1 Level AA. |
| NFR-USE-5 | The dashboard shall be usable at viewport widths from 360 px to 2560 px. |
| NFR-USE-6 | Every destructive action shall require explicit confirmation naming the affected resource. |
| NFR-USE-7 | Every error message presented to a user shall state what failed and what the user can do about it. |

### 3.3.4 Reliability and Availability (NFR-REL)

| ID | Requirement |
|---|---|
| NFR-REL-1 | The system shall achieve 99% availability of the API and dashboard, measured monthly, excluding scheduled maintenance. |
| NFR-REL-2 | No scan job shall be lost as a result of a worker crash; jobs shall be redelivered and resumed. |
| NFR-REL-3 | The system shall recover automatically from transient database or queue unavailability of up to 60 seconds without data loss. |
| NFR-REL-4 | Failure of an external dependency (OSV, SMTP) shall degrade the affected feature only, never the whole scan. |
| NFR-REL-5 | The database shall be backed up daily with a recovery point objective of 24 hours and a recovery time objective of 4 hours. |

### 3.3.5 Maintainability (NFR-MAINT)

| ID | Requirement |
|---|---|
| NFR-MAINT-1 | Automated test coverage shall be at least 80% of statements for the scan engine and API, with every detector covered by tests against a purpose-built vulnerable fixture application. |
| NFR-MAINT-2 | Adding a new detector shall require only the creation of a module implementing the detector interface and its registration; no change to engine core code. |
| NFR-MAINT-3 | The codebase shall pass linting and type-checking with zero errors as a condition of merge. |
| NFR-MAINT-4 | The system shall emit structured logs with a correlation identifier propagated across API request, queue job, and worker execution. |
| NFR-MAINT-5 | Public modules and all detector logic shall carry documentation comments explaining intent and detection rationale. |
| NFR-MAINT-6 | Database schema changes shall be applied exclusively through versioned, reversible migrations. |

### 3.3.6 Scalability (NFR-SCAL)

| ID | Requirement |
|---|---|
| NFR-SCAL-1 | Scan throughput shall scale by adding worker processes without change to application code or configuration schema. |
| NFR-SCAL-2 | The API tier shall be stateless, permitting horizontal scaling behind a load balancer. |
| NFR-SCAL-3 | The system shall sustain 20 concurrent scans on a deployment of 4 workers. |
| NFR-SCAL-4 | Findings and evidence tables shall be indexed and, where necessary, partitioned such that query performance degrades no worse than logarithmically with row count. |

### 3.3.7 Portability and Compatibility (NFR-PORT / NFR-COMP)

| ID | Requirement |
|---|---|
| NFR-PORT-1 | The complete system shall run via a single container-orchestration definition on any host providing a compatible container runtime. |
| NFR-PORT-2 | The system shall run on Linux, macOS, and Windows (via WSL2) development hosts. |
| NFR-COMP-1 | The dashboard shall support the current and immediately preceding major versions of Chrome, Firefox, Safari, and Edge. |
| NFR-COMP-2 | The scan engine shall correctly handle HTTP/1.1 and HTTP/2 targets. |
| NFR-COMP-3 | The scan engine shall correctly handle responses in UTF-8, ISO-8859-1, and other declared encodings without corrupting evidence. |

## 3.4 Software System Attributes Summary

| Attribute | Target |
|---|---|
| Availability | 99% monthly |
| Mean time to recovery | ≤ 4 hours |
| False positive rate | ≤ 15% of reported `HIGH`/`CRITICAL` findings on the benchmark suite ([7.3](#73-detector-accuracy-validation)) |
| Detection rate | ≥ 85% of benchmark-suite vulnerabilities within the detector catalogue's declared coverage |
| Test coverage | ≥ 80% statements |
| Accessibility | WCAG 2.1 AA |

## 3.5 Data Requirements

| ID | Requirement |
|---|---|
| DR-1 | All persistent data shall reside in a relational database with referential integrity enforced by foreign key constraints. |
| DR-2 | Findings shall be immutable once written; triage state shall be recorded as a separate, versioned association. |
| DR-3 | Audit records shall be append-only at the database privilege level. |
| DR-4 | Evidence payloads shall be stored separately from finding metadata to permit independent retention and purging. |
| DR-5 | All timestamps shall be stored in UTC with timezone information. |
| DR-6 | Deletion of a target shall cascade to its scans, findings, and evidence, but shall not delete audit records; those shall be anonymised. |

## 3.6 Design Constraints

| ID | Constraint |
|---|---|
| DC-1 | The implementation shall use TypeScript in strict mode for all first-party code, client and server. |
| DC-2 | The server framework shall be NestJS; the client framework shall be React with Vite. |
| DC-3 | Persistence shall use PostgreSQL accessed through the Prisma ORM. |
| DC-4 | Asynchronous work shall be queued through BullMQ backed by Redis. |
| DC-5 | JavaScript rendering shall use Playwright with headless Chromium. |
| DC-6 | Real-time dashboard updates shall use WebSocket transport. |
| DC-7 | The API shall follow REST conventions and shall publish an OpenAPI 3.1 specification generated from the implementation. |
| DC-8 | The system shall be packaged as containers with a single orchestration definition for local and demonstration deployment. |
| DC-9 | Every detector shall declare its own metadata — identifier, version, category, CWE, default severity, and whether it is passive or active — as data, not as code branches in the engine. |
| DC-10 | Declarative detector templates (`FR-5.2.1`) shall be authored in YAML and validated against a published JSON Schema. The template format shall support: request specification (method, path, headers, parameter injection points), response matching (status, header, body regular expression, structural condition), and finding metadata. |
| DC-11 | The template interpreter shall issue every request through the Scope Guard (`FR-8.1`). It shall not be possible for a template to originate traffic that bypasses scope, rate-limit, or blocklist enforcement. |

---

# 4. Use Case Specifications

## 4.1 Use Case Inventory

| ID | Use Case | Primary Actor | Requirements |
|---|---|---|---|
| UC-1 | Register and verify a target | Analyst | FR-2.1 – FR-2.8 |
| UC-2 | Execute a scan | Analyst | FR-3.*, FR-4.*, FR-5.* |
| UC-3 | Triage findings | Developer | FR-6.5 – FR-6.8 |
| UC-4 | Generate and export a report | Viewer | FR-7.* |
| UC-5 | Halt a scan for safety | Analyst / System | FR-3.7, FR-5.10, FR-8.4 |
| UC-6 | Administer users and quotas | Administrator | FR-8.8 – FR-8.10 |

## 4.2 UC-1 — Register and Verify a Target

| Field | Value |
|---|---|
| **Actor** | Security Analyst |
| **Goal** | Add a target and establish the right to scan it |
| **Precondition** | Actor is authenticated with role `ANALYST` or above and has a confirmed email address |
| **Postcondition (success)** | Target exists in state `VERIFIED` and is eligible for scanning |
| **Trigger** | Actor selects "Add Target" |

**Main flow**

1. Actor supplies the target origin and a label.
2. System validates syntax, scheme, and public DNS resolution (`FR-2.2`).
3. System checks the origin against the blocklist and private-address rules (`FR-2.5`, `FR-2.6`).
4. System presents the authorisation declaration; actor affirms authority to test (`FR-2.8`).
5. System records the declaration immutably with timestamp and source IP.
6. System generates a verification token and presents both verification methods (`FR-2.3`).
7. Actor publishes the token by DNS TXT record or `/.well-known/` file.
8. Actor requests verification.
9. System checks for the token, finds it, and transitions the target to `VERIFIED`.
10. System writes an audit record and confirms to the actor.

**Alternative flows**

- **1a — Target already registered in this organisation:** System reports the existing target and offers to open it. Use case ends.
- **9a — Token not found:** System reports which method it checked and what it observed. Target remains `PENDING_VERIFICATION`. Actor may retry; the token remains valid for 7 days.

**Exception flows**

- **2a — Origin does not resolve:** System rejects registration with a diagnostic naming the DNS failure.
- **3a — Origin is blocklisted or resolves to a private address:** System refuses registration, records the attempt in the audit log, and displays the policy reason. No retry is offered.

## 4.3 UC-2 — Execute a Scan

| Field | Value |
|---|---|
| **Actor** | Security Analyst |
| **Goal** | Assess a verified target and obtain findings |
| **Precondition** | Target is `VERIFIED`; organisation is within its concurrency and daily quotas |
| **Postcondition (success)** | Scan is `COMPLETED` with a deduplicated, severity-ranked finding set |
| **Trigger** | Actor selects "Start Scan" |

**Main flow**

1. Actor selects the target and a scan profile.
2. Actor optionally adjusts rate limit, crawl depth, page ceiling, and headers (`FR-3.3`).
3. System validates the configuration against administrator-set ceilings and quota (`FR-3.9`).
4. System creates the scan in state `QUEUED`, records the exact configuration and detector versions (`FR-3.12`), and enqueues the job.
5. A worker claims the job; scan transitions to `RUNNING`.
6. Worker re-confirms the target's verification status before the first request (`FR-8.1`).
7. Worker crawls the target within scope, rendering JavaScript pages (`FR-4.1`, `FR-4.2`).
8. Worker executes passive detectors against every response (`FR-5.3`).
9. Worker executes safe active detectors against discovered parameters and forms (`FR-5.4`).
10. Worker normalises, deduplicates, scores, and persists findings (`FR-5.5` – `FR-5.7`, `FR-6.1`).
11. System streams progress to the dashboard throughout (`FR-3.6`).
12. System compares against the previous scan and classifies findings as `NEW`, `PERSISTING`, or `RESOLVED` (`FR-6.7`).
13. System transitions the scan to `COMPLETED` and notifies the actor (`FR-3.11`).

**Alternative flows**

- **7a — Crawl limit reached:** Discovery terminates cleanly; the scan records which limit bound it and proceeds to detection (`FR-4.7`).
- **7b — Blocking detected:** Scan continues and marks affected results reduced-confidence (`FR-4.6`).
- **9a — A detector throws:** The failure is logged against the scan; remaining detectors continue (`FR-5.9`).

**Exception flows**

- **6a — Target verification has lapsed:** Scan transitions to `FAILED` with reason `VERIFICATION_EXPIRED`; no request is issued.
- **Any step — Target degradation detected:** Scan transitions to `ABORTED_SAFETY`, outbound traffic stops, and partial findings are retained and clearly marked partial (`FR-5.10`).
- **Any step — Worker crash:** Job is redelivered and resumed from checkpoint (`FR-3.10`, `NFR-REL-2`).

## 4.4 UC-3 — Triage Findings

| Field | Value |
|---|---|
| **Actor** | Developer |
| **Goal** | Determine which findings are real and record decisions |
| **Precondition** | A `COMPLETED` scan exists for a target in the actor's organisation |
| **Postcondition** | Each reviewed finding carries a triage status that persists into future scans |

**Main flow**

1. Actor opens the scan's findings, sorted by severity (`FR-6.8`).
2. Actor opens a finding and reads the plain-language description, then the evidence (`FR-6.2`, `NFR-USE-2`).
3. Actor reproduces the issue independently using the retained request/response pair (`FR-6.3`).
4. Actor sets the triage status with an optional justification (`FR-6.5`).
5. System records the decision and applies it to future rediscoveries of the same finding (`FR-6.6`).

**Alternative flow**

- **4a — Actor marks `FALSE_POSITIVE`:** System requests a reason, retains it, and suppresses the finding from default views while keeping it retrievable.

## 4.5 UC-5 — Halt a Scan for Safety

| Field | Value |
|---|---|
| **Actors** | Security Analyst (manual); System (automatic) |
| **Goal** | Stop scanning immediately when the target may be affected |
| **Postcondition** | All outbound requests for the affected scan(s) have ceased within 5 seconds |

**Main flow (manual)**

1. Actor selects "Cancel Scan".
2. System confirms the destructive action, naming the scan and target (`NFR-USE-6`).
3. System signals the worker; the worker drains in-flight requests and issues no new ones.
4. Scan transitions to `CANCELLED`; partial findings are retained and marked partial.
5. System writes an audit record.

**Main flow (automatic)**

1. Worker observes sustained `5xx` responses or response times exceeding five times baseline.
2. Worker halts outbound traffic immediately.
3. Scan transitions to `ABORTED_SAFETY` with the triggering metric recorded.
4. System notifies the requesting user with the reason.

**Administrator variant**

1. Administrator activates the system-wide kill switch (`FR-8.4`).
2. All running scans across all organisations transition to `CANCELLED`.
3. The queue stops dispatching new jobs until the switch is released.

---

# 5. Data Model

## 5.1 Entity-Relationship Overview

```
Organisation 1─────┬──< User
                   └──< Target ──< Scan ──< Finding ──< Evidence
                                     │         │
                                     │         └──< FindingOccurrence
                                     └──< RequestLog

Target 1──< VerificationAttempt
Target 1──1 ScopeRule
Finding 1──< TriageDecision
User 1──< AuditRecord
Detector 1──< Finding
```

## 5.2 Entity Definitions

### Organisation
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `name` | string | |
| `maxConcurrentScans` | integer | Quota, administrator-set |
| `maxScansPerDay` | integer | Quota, administrator-set |
| `evidenceRetentionDays` | integer | Default 90 |
| `createdAt` | timestamptz | |

### User
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `organisationId` | UUID | FK → Organisation |
| `email` | citext | Unique |
| `passwordHash` | string | Argon2id |
| `role` | enum | `ADMIN` \| `ANALYST` \| `DEVELOPER` \| `VIEWER` |
| `emailVerifiedAt` | timestamptz | Null until confirmed |
| `totpSecret` | string | Nullable, encrypted |
| `failedLoginCount` | integer | |
| `lockedUntil` | timestamptz | Nullable |

### Target
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `organisationId` | UUID | FK → Organisation |
| `label` | string | |
| `scheme` | enum | `http` \| `https` |
| `host` | string | |
| `port` | integer | |
| `status` | enum | `PENDING_VERIFICATION` \| `VERIFIED` \| `VERIFICATION_EXPIRED` \| `ARCHIVED` |
| `verificationToken` | string | |
| `verifiedAt` | timestamptz | |
| `verificationExpiresAt` | timestamptz | `verifiedAt` + 90 days |
| `authorisationAckAt` | timestamptz | Immutable |
| `authorisationAckIp` | inet | Immutable |

### ScopeRule
| Attribute | Type | Notes |
|---|---|---|
| `targetId` | UUID | FK → Target, unique |
| `includeHostPatterns` | string[] | |
| `includePathPatterns` | string[] | |
| `excludePathPatterns` | string[] | |
| `frozenParameters` | string[] | Parameters active detectors must not modify |
| `maxDepth` | integer | |
| `respectRobotsTxt` | boolean | Default true |

### Scan
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `targetId` | UUID | FK → Target |
| `requestedByUserId` | UUID | FK → User |
| `profile` | enum | `PASSIVE` \| `STANDARD` \| `THOROUGH` \| `CUSTOM` |
| `configSnapshot` | jsonb | Full effective configuration, immutable |
| `detectorVersions` | jsonb | Detector id → version, immutable |
| `status` | enum | `QUEUED` \| `RUNNING` \| `PAUSED` \| `COMPLETED` \| `FAILED` \| `CANCELLED` \| `ABORTED_SAFETY` |
| `terminationReason` | string | Nullable |
| `pagesCrawled` | integer | |
| `requestsIssued` | integer | |
| `limitReached` | string | Nullable — which ceiling bound the scan |
| `confidenceDegraded` | boolean | Set when blocking was detected |
| `startedAt` / `completedAt` | timestamptz | |

### Detector
| Attribute | Type | Notes |
|---|---|---|
| `id` | string | Stable identifier, e.g. `headers.hsts.missing` |
| `version` | string | Semantic version |
| `name` | string | |
| `mode` | enum | `PASSIVE` \| `ACTIVE_SAFE` |
| `implementation` | enum | `DECLARATIVE` \| `NATIVE` — per `FR-5.2.2` |
| `templateSource` | text | Nullable; the YAML template body for `DECLARATIVE` detectors |
| `cwe` | string | |
| `owaspCategory` | string | |
| `defaultCvssVector` | string | |

### Finding
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `scanId` | UUID | FK → Scan |
| `detectorId` | string | FK → Detector |
| `fingerprint` | string | Deterministic hash for cross-scan identity |
| `title` | string | |
| `description` | text | |
| `remediation` | text | |
| `cvssVector` | string | |
| `cvssScore` | numeric(3,1) | |
| `severity` | enum | `CRITICAL` \| `HIGH` \| `MEDIUM` \| `LOW` \| `INFO` |
| `confidence` | enum | `CONFIRMED` \| `FIRM` \| `TENTATIVE` |
| `deltaStatus` | enum | `NEW` \| `PERSISTING` \| `RESOLVED` |
| Immutable once written (`DR-2`) | | |

### FindingOccurrence
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `findingId` | UUID | FK → Finding |
| `url` | text | |
| `parameter` | string | Nullable |
| `method` | string | |

### Evidence
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `occurrenceId` | UUID | FK → FindingOccurrence |
| `requestSanitised` | text | Encrypted at rest |
| `responseSanitised` | text | Encrypted at rest |
| `redactionsApplied` | string[] | What was removed and why |
| `purgeAfter` | timestamptz | |

### TriageDecision
| Attribute | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `targetId` | UUID | FK → Target — decisions bind to target + fingerprint, not to one scan |
| `fingerprint` | string | |
| `status` | enum | `OPEN` \| `CONFIRMED` \| `FALSE_POSITIVE` \| `ACCEPTED_RISK` \| `RESOLVED` |
| `justification` | text | |
| `decidedByUserId` | UUID | FK → User |
| `decidedAt` | timestamptz | |

### AuditRecord
| Attribute | Type | Notes |
|---|---|---|
| `id` | bigserial | Primary key |
| `actorUserId` | UUID | Nullable for system actions |
| `action` | string | |
| `resourceType` / `resourceId` | string / UUID | |
| `detail` | jsonb | |
| `sourceIp` | inet | |
| `occurredAt` | timestamptz | |
| Append-only at database privilege level (`DR-3`) | | |

---

# 6. External Interface Specifications

## 6.1 User Interfaces

| Screen | Purpose | Key requirements |
|---|---|---|
| Sign in / Register | Authentication | FR-1.1, FR-1.5, NFR-SEC-9 |
| Dashboard home | Posture across all targets, recent scans, severity distribution | FR-6.9 |
| Targets list | All targets with verification status and last scan result | FR-2.* |
| Target detail | Scope configuration, verification state, scan history, trend | FR-2.7, FR-6.9 |
| New scan | Profile selection, configuration, quota display | FR-3.1 – FR-3.3 |
| Live scan view | Phase, counters, streaming findings, pause/cancel controls | FR-3.6, FR-3.7 |
| Findings list | Filterable, sortable, colour- *and* label-coded by severity | FR-6.8, NFR-USE-4 |
| Finding detail | Plain-language explanation, evidence, remediation, triage controls | FR-6.2 – FR-6.5 |
| Reports | Template and format selection, generation status, download | FR-7.* |
| Administration | Users, quotas, blocklist, audit log, kill switch | FR-8.4, FR-8.8, FR-8.10 |

**General UI requirements:** severity shall be conveyed by label and shape as well as colour (`NFR-USE-4`); all views shall be operable by keyboard alone; the layout shall be responsive per `NFR-USE-5`.

## 6.2 Application Programming Interface

The API shall be REST over HTTPS, JSON-encoded, versioned under `/api/v1`, and documented by a generated OpenAPI 3.1 specification (`DC-7`).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Authenticate; issue tokens |
| `POST` | `/auth/refresh` | Exchange refresh token |
| `POST` | `/auth/logout` | Revoke session |
| `GET` `POST` | `/targets` | List / create targets |
| `GET` `PATCH` `DELETE` | `/targets/{id}` | Read / update / delete target |
| `POST` | `/targets/{id}/verify` | Attempt ownership verification |
| `PUT` | `/targets/{id}/scope` | Set scope rules |
| `GET` `POST` | `/scans` | List / initiate scans |
| `GET` | `/scans/{id}` | Scan status and summary |
| `POST` | `/scans/{id}/pause` `/resume` `/cancel` | Lifecycle control |
| `GET` | `/scans/{id}/findings` | Findings, filterable and paginated |
| `GET` | `/findings/{id}` | Finding with evidence |
| `PUT` | `/findings/{id}/triage` | Record triage decision |
| `POST` | `/scans/{id}/reports` | Request report generation |
| `GET` | `/reports/{id}` | Report status / download |
| `GET` | `/admin/audit` | Audit log (ADMIN only) |
| `POST` | `/admin/kill-switch` | System-wide halt (ADMIN only) |
| `GET` | `/health` | Component health |

**Conventions:** authentication by `Authorization: Bearer <token>`; errors returned as RFC 9457 problem details; list endpoints cursor-paginated; all mutating endpoints idempotency-key aware.

## 6.3 Real-Time Interface

A WebSocket channel at `/ws/scans/{id}` shall emit, to authorised subscribers only:

| Event | Payload |
|---|---|
| `scan.progress` | phase, pagesCrawled, requestsIssued, detectorsCompleted, findingsCount |
| `scan.finding` | Newly persisted finding summary |
| `scan.status` | New lifecycle state and reason |
| `scan.warning` | Blocking detected, detector failure, limit reached |

## 6.4 Hardware Interfaces

None. The system requires no specialised hardware beyond a standard server or workstation.

## 6.5 Communications Interfaces

| Interface | Protocol | Notes |
|---|---|---|
| Client ↔ API | HTTPS (TLS 1.2+), WSS | `NFR-SEC-1` |
| API ↔ Database | PostgreSQL wire protocol over TLS | |
| API ↔ Queue | Redis protocol, authenticated | |
| Worker ↔ Target | HTTP/1.1, HTTP/2 over TCP/TLS | Rate-limited and scope-enforced (`FR-8.1`) |
| API ↔ OSV | HTTPS REST | `FR-5.8` |
| API ↔ SMTP relay | SMTP over TLS | |

---

# 7. Verification and Validation

## 7.1 Verification Method by Requirement Class

| Requirement class | Method |
|---|---|
| Functional (FR) | Automated integration and end-to-end tests against a controlled vulnerable fixture application |
| Detector accuracy | Benchmark suite ([7.3](#73-detector-accuracy-validation)) with known ground truth |
| Performance (NFR-PERF) | Load testing with measured percentiles against stated thresholds |
| Security (NFR-SEC) | Static analysis, dependency scanning, manual review, and self-scan (`NFR-SEC-12`) |
| Usability (NFR-USE) | Moderated task-completion sessions with representatives of each user class; automated accessibility audit |
| Reliability (NFR-REL) | Fault injection — worker kill, database disconnect, external-service timeout |
| Safety (FR-8, C-1) | Negative testing: attempts to scan unverified, blocklisted, and private-address targets shall all be refused and audited |

## 7.2 Test Environment

All scanning during development and demonstration shall be conducted exclusively against:

1. A purpose-built vulnerable fixture application, deployed within the project's own infrastructure and seeded with known, catalogued weaknesses.
2. Established intentionally-vulnerable training applications hosted locally under their own licence terms.
3. Targets for which the project team holds documented written authorisation.

Scanning of any other third-party system, including for demonstration purposes, is prohibited.

## 7.3 Detector Accuracy Validation

A benchmark suite shall be constructed in which every vulnerability is deliberately introduced and catalogued, providing ground truth. For each detector the suite shall measure true positives, false positives, and false negatives, yielding precision and recall. The targets in [Section 3.4](#34-software-system-attributes-summary) shall be evaluated against this suite, and the results published in the project report — including where they fall short.

## 7.4 Acceptance Criteria

The system shall be accepted when:

1. All **M**-priority functional requirements pass their verification tests.
2. All security non-functional requirements are satisfied, including a clean self-scan (`NFR-SEC-12`).
3. Detection rate and false-positive rate meet the targets in [Section 3.4](#34-software-system-attributes-summary), or the shortfall is measured, explained, and documented.
4. Every safety negative test refuses the prohibited action and produces a corresponding audit record.
5. A full end-to-end demonstration — register, verify, scan, triage, export — completes against the fixture application without manual intervention.

---

# 8. Appendices

## 8.1 Detector Catalogue

### 8.1.1 Passive Detectors

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

### 8.1.2 Safe Active Detectors

All detectors in this table are restricted by `FR-5.4`: idempotent methods, benign marker payloads, no data modification, no command execution, no file writing.

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

### 8.1.3 Explicitly Excluded Techniques

| Technique | Reason for exclusion |
|---|---|
| Time-based blind SQL injection | Indistinguishable from network variance within the response budget; high false-positive rate |
| OS command injection | Cannot be probed without risk of execution on the target |
| File upload exploitation | Necessarily writes to the target, violating `C-1` |
| XML External Entity with outbound resolution | Constitutes SSRF against third parties |
| Server-side request forgery exploitation | Would make the target attack other systems |
| Insecure deserialisation exploitation | Cannot be probed without risk of code execution |
| Brute force / credential stuffing | Attacks accounts rather than assessing configuration |
| Denial of service, stress, resource exhaustion | Directly harms the target |

## 8.2 Role-Permission Matrix

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

## 8.3 Deferred Requirements

The following are recognised as valuable but are outside the scope of this release. They are recorded here so that the architecture does not preclude them.

| ID | Deferred capability | Architectural provision required |
|---|---|---|
| DEF-1 | Authenticated scanning (session, form login, OAuth). **Recognised as the single largest coverage limitation of this release.** Industry experience with credentialed scanning reports finding-count increases exceeding 300% over unauthenticated equivalents, because the majority of an application's attack surface — user data handling, privilege boundaries, business logic — lies behind a login. Unauthenticated results shall therefore not be interpreted as a complete assessment, and reports shall state this limitation explicitly per `FR-7.5`. | Credential vault; session state in the crawler |
| DEF-2 | API-specific scanning driven by OpenAPI or GraphQL introspection | Alternative discovery source feeding the same detector pipeline |
| DEF-3 | CI/CD integration with a build-failing gate | SARIF output already satisfies the data contract (`FR-7.3`) |
| DEF-4 | Issue-tracker integration (Jira, GitHub Issues) | Outbound webhook abstraction on the findings domain |
| DEF-5 | Distributed scanning from multiple geographic egress points | Worker already decoupled by queue (`DC-4`) |
| DEF-6 | Machine-learning-assisted false-positive suppression | Triage decisions already persisted as labelled training data (`TriageDecision`) |
| DEF-7 | Single sign-on (SAML / OIDC) | Pluggable authentication strategy |
| DEF-8 | Network-agent deployment for internal targets | Worker already isolated behind the queue boundary |

## 8.4 Severity Model

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

## 8.5 Requirements Traceability Matrix

| Objective | Requirements | Use cases | Verification |
|---|---|---|---|
| OBJ-1 Reduce manual assessment effort | FR-3.*, FR-4.*, FR-5.1, FR-5.2 | UC-2 | NFR-PERF-3; end-to-end demonstration (7.4.5) |
| OBJ-2 Actionable findings | FR-6.2, FR-6.3, FR-7.1, FR-7.2 | UC-3, UC-4 | Usability sessions (7.1); benchmark precision (7.3) |
| OBJ-3 Non-destructive scanning | C-1, FR-5.4, FR-5.10, FR-8.3 | UC-5 | Safety negative testing (7.1); fixture integrity assertions |
| OBJ-4 Enforced authorisation | C-2, FR-2.3 – FR-2.8, FR-8.1, FR-8.2, FR-8.5 | UC-1 | Safety negative testing (7.1); audit record assertions (7.4.4) |
| OBJ-5 Clarity for all user classes | NFR-USE-2, NFR-USE-3, NFR-USE-4, FR-7.2 | UC-3, UC-4 | Moderated task-completion sessions; accessibility audit |

## 8.6 Open Issues

| # | Issue | Owner | Required by |
|---|---|---|---|
| OI-1 | Selection of the breached-password corpus for `FR-1.3`, balancing coverage against distribution size | Team | Start of implementation |
| OI-2 | Whether SARIF export (`FR-7.3`) targets GitHub code scanning specifically or generic consumers | Team + Supervisor | Design of reporting module |
| OI-3 | Enumeration wordlist size for `A-09` under the Thorough profile, balancing coverage against target load | Team | Detector implementation |
| OI-4 | Hosting arrangement for the project-controlled sentinel host required by `A-04` | Team | Detector implementation |
| OI-5 | Whether evidence encryption (`NFR-SEC-7`) uses application-level or database-level encryption | Team | Data layer implementation |

---

*End of document.*
