import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FindingDetail, TriageInput } from "@/services/findings";
import { aFindingDetail } from "@/test-support/fixtures";
import { FindingApiError, resetMocks, stub, toasts } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * One finding (F.6).
 *
 * The order is part of the requirement: a plain-language explanation comes
 * before technical detail, and evidence is disclosed only on request. Evidence
 * the API withholds is explained rather than shown as an empty box, so a user
 * can tell "withheld" apart from "never recorded".
 */

let finding: FindingDetail;
let canWrite = true;
let loadFails: Error | null = null;
const triageCalls: TriageInput[] = [];

const { FindingDetailPage } = await import("./finding-detail-page");

async function showFinding(detail: FindingDetail = finding) {
  finding = detail;
  renderPage(<FindingDetailPage />, {
    path: "/findings/:id",
    route: `/findings/${detail.id}`,
  });
  await screen.findByRole("heading", { name: detail.name });
}

beforeEach(() => {
  resetMocks();
  finding = aFindingDetail();
  canWrite = true;
  loadFails = null;
  triageCalls.length = 0;

  stub.findings("fetchFinding", (async () => {
    if (loadFails) throw loadFails;
    return { finding };
  }) as never);
  stub.findings("triageFinding", (async (_id: string, input: TriageInput) => {
    triageCalls.push(input);
    return {
      finding: { ...finding, triage: { ...finding.triage, state: input.state } },
      changed: true,
    };
  }) as never);
  stub.role("useCanWrite", (() => canWrite) as never);
});

const follows = (earlier: string, later: string) =>
  Boolean(
    screen.getByText(earlier).compareDocumentPosition(screen.getByText(later)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );

describe("reading a finding", () => {
  test("puts the plain explanation before the fix and the technical detail", async () => {
    await showFinding(
      aFindingDetail({
        description: "Anyone can read your session cookie.",
        remediation: "Mark the cookie HttpOnly.",
        cwe: "CWE-1004",
      }),
    );

    expect(follows("Anyone can read your session cookie.", "Mark the cookie HttpOnly.")).toBe(true);
    expect(follows("Mark the cookie HttpOnly.", "CWE-1004")).toBe(true);
  });

  test("keeps redacted evidence behind a disclosure", async () => {
    await showFinding(
      aFindingDetail({
        evidence: {
          status: "AVAILABLE",
          expiresAt: "2026-12-20T10:00:00.000Z",
          redactionVersion: 1,
          requestHeaders: { Cookie: "session=[REDACTED]" },
          requestBody: null,
          responseHeaders: null,
          responseBody: "<p>reflected</p>",
          curlCommand: null,
          extractedSnippet: null,
        },
      }),
    );

    const summary = screen.getByText("Show request and response");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    await userEvent.setup().click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText("<p>reflected</p>")).toBeTruthy();
  });

  test("says why evidence is withheld when redaction is unconfirmed", async () => {
    await showFinding(
      aFindingDetail({ evidence: { status: "WITHHELD_UNREDACTED", expiresAt: "2026-12-20T10:00:00.000Z" } }),
    );
    expect(screen.getByText("Evidence withheld")).toBeTruthy();
  });

  test("says when evidence was purged", async () => {
    await showFinding(
      aFindingDetail({ evidence: { status: "PURGED", purgedAt: "2026-09-21T10:00:00.000Z" } }),
    );
    expect(screen.getByText(/Evidence purged on/)).toBeTruthy();
  });

  test("reports a finding that cannot be loaded", async () => {
    loadFails = new FindingApiError(404, "Not Found");
    renderPage(<FindingDetailPage />, { path: "/findings/:id", route: "/findings/missing" });

    expect(await screen.findByText("Finding not found")).toBeTruthy();
  });
});

describe("triage", () => {
  test("shows the history to everyone and the controls only to writers", async () => {
    canWrite = false;
    await showFinding(
      aFindingDetail({
        triageHistory: [
          {
            id: "h-1",
            state: "ACCEPTED_RISK",
            justification: "Behind the VPN",
            createdAt: "2026-09-21T10:00:00.000Z",
            user: { id: "user-1", name: "Sam" },
          },
        ],
      }),
    );

    expect(screen.getByText("Behind the VPN")).toBeTruthy();
    expect(screen.getByText(/Sam ·/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record triage" })).toBeNull();
  });

  test("requires a reason to accept a risk, then records it", async () => {
    const user = userEvent.setup();
    await showFinding();

    await user.click(screen.getByText("Accepted risk"));
    await user.click(screen.getByRole("button", { name: "Record triage" }));
    expect(await screen.findByText(/A justification is required/)).toBeTruthy();
    expect(triageCalls).toHaveLength(0);

    await user.type(screen.getByLabelText(/Justification/), "Compensating WAF rule");
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    await waitFor(() =>
      expect(triageCalls).toEqual([
        { state: "ACCEPTED_RISK", justification: "Compensating WAF rule" },
      ]),
    );
    await waitFor(() =>
      expect(toasts).toContainEqual({ kind: "success", message: "Triage recorded" }),
    );
  });

  test("shows a refusal from the API", async () => {
    const user = userEvent.setup();
    stub.findings("triageFinding", (async () => {
      throw new FindingApiError(403, "Forbidden");
    }) as never);
    await showFinding();

    await user.click(screen.getByText("Confirmed"));
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    expect(await screen.findByText("Forbidden")).toBeTruthy();
  });
});
