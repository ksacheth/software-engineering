/**
 * Seed findings for local development of the F.6 dashboard.
 *
 *   bun run --cwd apps/api seed:findings --email you@example.com
 *
 * Nothing writes findings until the orchestrator and detectors exist, so
 * without this the findings views can only be seen through tests. It attaches
 * one clearly labelled target to the named user's organisation, with two
 * completed scans whose findings cover every severity, every diff status,
 * redacted, unredacted and purged evidence, and some triage history.
 *
 * Re-running rebuilds that one target and touches nothing else. The target is
 * left unverified with an empty verified IP set, so it can never be scanned
 * (ADR-0004): its origin is not a real host.
 *
 * Refuses to run in production.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@wvs/database";
import {
  createCompletedScan,
  createDiff,
  createEvidence,
  createFinding,
  recordTriage,
  type FindingInput,
} from "../dev-data/findings";

const SEED_ORIGIN = "https://juice-shop.seed.example.test";
const SEED_LABEL = "Dev seed: Juice Shop (findings demo)";
const DAY = 24 * 60 * 60 * 1000;

type Spec = Omit<FindingInput, "scanJobId" | "targetId" | "fingerprint"> & {
  fingerprint: string;
};

const url = (path: string) => `${SEED_ORIGIN}${path}`;

const CATALOGUE: Record<string, Spec> = {
  sqli: {
    fingerprint: "seed-a02-login-email",
    detectorId: "A-02",
    name: "SQL Injection (error-based)",
    description:
      "The login form's email field passes what you type straight into a database query. A quote character made the database return an error, which means an attacker can change the query and may read or alter data they should never see.",
    remediation:
      "Use parameterised queries or the ORM's query builder for every database call, and never build SQL by joining strings with user input.",
    severity: "CRITICAL",
    confidence: "CONFIRMED",
    cwe: "CWE-89",
    owaspCategory: "A03:2021",
    affectedUrl: url("/rest/user/login"),
    affectedParameter: "email",
    cvssScore: 9.8,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  },
  git: {
    fingerprint: "seed-p21-git",
    detectorId: "P-21",
    name: "Exposed version control directory",
    description:
      "The site serves its .git directory. Anyone can download the source code and its full history, including any secrets that were ever committed.",
    remediation:
      "Block access to /.git at the web server, and remove the directory from the deployed files.",
    severity: "CRITICAL",
    confidence: "CONFIRMED",
    cwe: "CWE-527",
    owaspCategory: "A05:2021",
    affectedUrl: url("/.git/HEAD"),
    cvssScore: 7.5,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
  },
  xss: {
    fingerprint: "seed-a01-search-q",
    detectorId: "A-01",
    name: "Reflected Cross-Site Scripting",
    description:
      "The search page repeats the search term back into the page without encoding it. A crafted link can run an attacker's script in the victim's browser, with the victim's session.",
    remediation:
      "Encode output for the context it is written into, and add a Content-Security-Policy as a second line of defence.",
    severity: "HIGH",
    confidence: "FIRM",
    cwe: "CWE-79",
    owaspCategory: "A03:2021",
    affectedUrl: url("/search?q=wvs-marker"),
    affectedParameter: "q",
    cvssScore: 6.1,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N",
    occurrenceCount: 3,
    occurrences: [
      { url: url("/search?q=wvs-marker"), parameter: "q" },
      { url: url("/#/search?q=wvs-marker"), parameter: "q" },
      { url: url("/rest/products/search?q=wvs-marker"), parameter: "q" },
    ],
  },
  jquery: {
    fingerprint: "seed-p19-jquery",
    detectorId: "P-19",
    name: "Known-vulnerable component: jQuery 2.2.4",
    description:
      "The page loads jQuery 2.2.4, a version with published vulnerabilities that let untrusted input become script.",
    remediation: "Upgrade jQuery to 3.5.0 or later.",
    severity: "HIGH",
    confidence: "FIRM",
    cwe: "CWE-1104",
    owaspCategory: "A06:2021",
    affectedUrl: url("/"),
    cvssScore: 6.1,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N",
    cveId: "CVE-2020-11022",
    epssScore: 0.0194,
    epssPercentile: 0.887,
  },
  cors: {
    fingerprint: "seed-a05-cors",
    detectorId: "A-05",
    name: "CORS misconfiguration",
    description:
      "The API reflects any Origin header back as allowed. Any website a signed-in user visits could read their data from this API.",
    remediation:
      "Allow only the origins that need access, and never reflect the request's Origin back unchecked.",
    severity: "HIGH",
    confidence: "CONFIRMED",
    cwe: "CWE-942",
    owaspCategory: "A05:2021",
    affectedUrl: url("/api/Products"),
    cvssScore: null,
  },
  csp: {
    fingerprint: "seed-p01-csp",
    detectorId: "P-01",
    name: "Missing Content-Security-Policy",
    severity: "MEDIUM",
    confidence: "CONFIRMED",
    cwe: "CWE-693",
    owaspCategory: "A05:2021",
    affectedUrl: url("/"),
  },
  redirect: {
    fingerprint: "seed-a04-redirect",
    detectorId: "A-04",
    name: "Open Redirect",
    description:
      "The redirect endpoint sends visitors to any address in its 'to' parameter. Attackers use this to make phishing links look like they point at your site.",
    remediation:
      "Redirect only to paths on your own site, or to an allowlist of known destinations.",
    severity: "MEDIUM",
    confidence: "CONFIRMED",
    cwe: "CWE-601",
    owaspCategory: "A01:2021",
    affectedUrl: url("/redirect?to=https://sentinel.example"),
    affectedParameter: "to",
    cvssScore: 4.7,
  },
  cookie: {
    fingerprint: "seed-p07-cookie",
    detectorId: "P-07",
    name: "Cookie without Secure attribute",
    description:
      "The 'language' cookie is sent without the Secure attribute, so it can travel over unencrypted connections.",
    remediation: "Set the Secure attribute on every cookie.",
    severity: "MEDIUM",
    confidence: "CONFIRMED",
    cwe: "CWE-614",
    owaspCategory: "A05:2021",
    affectedUrl: url("/"),
  },
  hsts: {
    fingerprint: "seed-p02-hsts",
    detectorId: "P-02",
    name: "Missing HTTP Strict-Transport-Security",
    description:
      "The site does not tell browsers to always use HTTPS, so a first visit can be downgraded to plain HTTP by someone on the network.",
    remediation: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains.",
    severity: "LOW",
    confidence: "CONFIRMED",
    cwe: "CWE-319",
    owaspCategory: "A02:2021",
    affectedUrl: url("/"),
  },
  version: {
    fingerprint: "seed-p17-server",
    detectorId: "P-17",
    name: "Server version disclosure in headers",
    description:
      "The X-Powered-By header names the framework, which tells an attacker which known vulnerabilities to try.",
    remediation: "Remove X-Powered-By and version details from Server headers.",
    severity: "LOW",
    confidence: "CONFIRMED",
    cwe: "CWE-200",
    owaspCategory: "A05:2021",
    affectedUrl: url("/"),
  },
  securityTxt: {
    fingerprint: "seed-p30-security-txt",
    detectorId: "P-30",
    name: "Missing security.txt",
    description:
      "There is no /.well-known/security.txt, so a researcher who finds a problem has no published way to report it.",
    remediation: "Publish a security.txt file as described in RFC 9116.",
    severity: "INFO",
    confidence: "CONFIRMED",
    cwe: null,
    owaspCategory: null,
    affectedUrl: url("/.well-known/security.txt"),
  },
  fingerprinting: {
    fingerprint: "seed-p18-angular",
    detectorId: "P-18",
    name: "Technology fingerprint: Angular",
    description: "The site is built with Angular. This is informational.",
    remediation: "No action needed.",
    severity: "INFO",
    confidence: "TENTATIVE",
    cwe: null,
    owaspCategory: null,
    affectedUrl: url("/"),
  },
  directory: {
    fingerprint: "seed-p23-ftp-listing",
    detectorId: "P-23",
    name: "Directory listing enabled",
    description:
      "The /ftp directory lists its files, including backups that were never meant to be public.",
    remediation: "Turn off directory listing, and move the files out of the web root.",
    severity: "MEDIUM",
    confidence: "CONFIRMED",
    cwe: "CWE-548",
    owaspCategory: "A05:2021",
    affectedUrl: url("/ftp/"),
  },
};

/** Only in the previous scan: fixed since, so diff RESOLVED on the latest. */
const PREVIOUS_ONLY = ["directory", "cookie"];
/** Only in the latest scan: diff NEW. */
const LATEST_ONLY = ["sqli", "cors"];
/** Everything else appears in both: diff PERSISTING. */

function readEmail(): string {
  const index = process.argv.indexOf("--email");
  const email = index >= 0 ? process.argv[index + 1] : undefined;
  if (!email) {
    throw new Error("Usage: bun run seed:findings --email <user email>");
  }
  return email;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed:findings refuses to run in production.");
  }

  const email = readEmail();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  const member = user
    ? await prisma.member.findUnique({
        where: { userId: user.id },
        select: { organizationId: true },
      })
    : null;
  const organizationId = member?.organizationId;
  if (!user || !organizationId) {
    throw new Error(`No user with an organisation for ${email}.`);
  }

  // Rebuild only this target. Its scans, findings, diffs, evidence and triage
  // projection go with it by cascade; triage history is append-only and has no
  // foreign key (ADR-0002), so old rows stay behind keyed to a target id that
  // is never reused.
  await prisma.target.deleteMany({
    where: { organizationId, origin: SEED_ORIGIN },
  });

  const target = await prisma.target.create({
    data: {
      organizationId,
      origin: SEED_ORIGIN,
      label: SEED_LABEL,
      verificationToken: randomUUID(),
      verificationStatus: "UNVERIFIED",
      createdById: user.id,
    },
  });

  const previous = await createCompletedScan(prisma, {
    organizationId,
    targetId: target.id,
    createdById: user.id,
    completedAt: new Date(Date.now() - 8 * DAY),
  });
  const latest = await createCompletedScan(prisma, {
    organizationId,
    targetId: target.id,
    createdById: user.id,
    completedAt: new Date(Date.now() - 1 * DAY),
  });

  const keys = Object.keys(CATALOGUE);
  const inPrevious = keys.filter((key) => !LATEST_ONLY.includes(key));
  const inLatest = keys.filter((key) => !PREVIOUS_ONLY.includes(key));

  for (const key of inPrevious) {
    const spec = CATALOGUE[key]!;
    const finding = await createFinding(prisma, {
      ...spec,
      scanJobId: previous.id,
      targetId: target.id,
      createdAt: previous.completedAt!,
    });
    await createEvidence(prisma, finding.id, { isPurged: key === "directory" });
    await createDiff(prisma, {
      scanJobId: previous.id,
      targetId: target.id,
      fingerprint: spec.fingerprint,
      status: "NEW",
    });
  }

  for (const key of inLatest) {
    const spec = CATALOGUE[key]!;
    const finding = await createFinding(prisma, {
      ...spec,
      scanJobId: latest.id,
      targetId: target.id,
      createdAt: latest.completedAt!,
    });
    // One row whose redaction was never confirmed, to show it withheld.
    await createEvidence(prisma, finding.id, { isRedacted: key !== "cors" });
    await createDiff(prisma, {
      scanJobId: latest.id,
      targetId: target.id,
      fingerprint: spec.fingerprint,
      status: LATEST_ONLY.includes(key) ? "NEW" : "PERSISTING",
    });
  }

  for (const key of PREVIOUS_ONLY) {
    await createDiff(prisma, {
      scanJobId: latest.id,
      targetId: target.id,
      fingerprint: CATALOGUE[key]!.fingerprint,
      status: "RESOLVED",
    });
  }

  await prisma.scanJob.update({
    where: { id: previous.id },
    data: { findingsCount: inPrevious.length },
  });
  await prisma.scanJob.update({
    where: { id: latest.id },
    data: { findingsCount: inLatest.length },
  });

  const decisions = [
    { key: "xss", state: "CONFIRMED" as const, justification: null },
    {
      key: "fingerprinting",
      state: "FALSE_POSITIVE" as const,
      justification: "Informational only; the framework is public knowledge.",
    },
    {
      key: "hsts",
      state: "ACCEPTED_RISK" as const,
      justification: "Served behind a proxy that sets HSTS in production.",
    },
    { key: "jquery", state: "RESOLVED" as const, justification: "Upgraded in release 18.1; awaiting rescan." },
  ];
  for (const decision of decisions) {
    await recordTriage(prisma, {
      targetId: target.id,
      fingerprint: CATALOGUE[decision.key]!.fingerprint,
      state: decision.state,
      justification: decision.justification,
      userId: user.id,
    });
  }

  console.log(
    `[seed:findings] ${SEED_LABEL}: ${inPrevious.length} findings in the previous scan, ` +
      `${inLatest.length} in the latest, ${PREVIOUS_ONLY.length} resolved, ${decisions.length} triaged.`,
  );
  console.log(`[seed:findings] latest scan: /scans/${latest.id}`);
}

main()
  .catch((error) => {
    console.error("[seed:findings] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
