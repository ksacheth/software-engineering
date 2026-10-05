import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CreateReportInput, Report } from "@/services/reports";
import { renderPage } from "@/test-support/render";
import { resetMocks, stub, toasts } from "@/test-support/mocks";

/**
 * F.7 in the dashboard: requesting a report, watching it arrive, downloading
 * and sharing it.
 *
 * The role rules are asserted here as well as in the API tests because the
 * dashboard offering a control the API will refuse is its own kind of bug: a
 * VIEWER clicking Download on a file of raw evidence gets a 403 and no
 * explanation.
 */

const { ReportsPage } = await import("./reports-page");
const { GenerateReportDialog } = await import("./generate-report-dialog");

function aReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "report-1",
    scan: {
      id: "scan-1",
      completedAt: "2026-10-04T09:13:00.000Z",
      target: { id: "target-1", label: "Shop", origin: "https://shop.example.test" },
    },
    template: "EXECUTIVE_SUMMARY",
    format: "PDF",
    status: "READY",
    failureReason: null,
    fileSize: 20480,
    filters: { minSeverity: null, triageStates: [] },
    coverageLimitations: ["This was an unauthenticated scan."],
    includesEvidence: false,
    expiresAt: null,
    expired: false,
    share: { active: false, expiresAt: null },
    createdBy: { id: "user-1", name: "Asha" },
    createdAt: "2026-10-05T10:00:00.000Z",
    completedAt: "2026-10-05T10:00:05.000Z",
    ...overrides,
  };
}

let reports: Report[] = [];

function asRole(role: "ANALYST" | "VIEWER") {
  stub.role("useRole", (() => role) as never);
  stub.role("useCanWrite", (() => role !== "VIEWER") as never);
}

beforeEach(() => {
  resetMocks();
  reports = [aReport()];
  stub.reports("fetchReports", (async () => ({ reports })) as never);
  asRole("ANALYST");
});

describe("the reports list", () => {
  test("shows each report with its status and what it includes", async () => {
    reports = [
      aReport(),
      aReport({
        id: "report-2",
        template: "TECHNICAL_REPORT",
        format: "SARIF",
        status: "GENERATING",
        fileSize: null,
        filters: { minSeverity: "HIGH", triageStates: ["OPEN", "CONFIRMED"] },
      }),
      aReport({
        id: "report-3",
        status: "FAILED",
        failureReason: "The report could not be generated.",
      }),
    ];
    renderPage(<ReportsPage />);

    await screen.findByText("Generating");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("The report could not be generated.")).toBeTruthy();
    expect(screen.getByText("HIGH and above · Open, Confirmed")).toBeTruthy();
    // The first and the failed one are both 20 KB PDFs; the SARIF has no file yet.
    expect(screen.getAllByText("PDF · 20.0 KB")).toHaveLength(2);
    expect(screen.getByText("SARIF")).toBeTruthy();
  });

  test("downloads a ready report through a same-origin link", async () => {
    renderPage(<ReportsPage />);
    const link = await screen.findByRole("link", { name: /Download Executive Summary \(PDF\)/ });
    expect(link.getAttribute("href")).toBe("/api/reports/report-1/download");
  });

  test("does not offer a VIEWER a file of raw evidence, or sharing", async () => {
    asRole("VIEWER");
    reports = [aReport({ template: "TECHNICAL_REPORT", includesEvidence: true })];
    renderPage(<ReportsPage />);

    const button = await screen.findByRole("button", { name: /Download Technical Report/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("raw evidence");
    expect(screen.queryByRole("button", { name: /^Share/ })).toBeNull();
  });

  test("an expired report cannot be downloaded", async () => {
    reports = [aReport({ expired: true, expiresAt: "2026-10-01T00:00:00.000Z" })];
    renderPage(<ReportsPage />);
    await screen.findByText("Expired");
    expect(
      screen.getByRole("button", { name: /Download Executive Summary/ }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("announces a report that finishes while the page is open", async () => {
    reports = [aReport({ status: "GENERATING", fileSize: null })];
    const { queryClient } = renderPage(<ReportsPage />);
    await screen.findByText("Generating");
    expect(toasts).toHaveLength(0);

    reports = [aReport()];
    await queryClient.invalidateQueries({ queryKey: ["reports"] });
    await screen.findByText("Ready");
    expect(toasts).toContainEqual({
      kind: "success",
      message: "Executive Summary (PDF) for Shop is ready",
    });
  });

  test("a report already finished on load raises nothing", async () => {
    renderPage(<ReportsPage />);
    await screen.findByText("Ready");
    expect(toasts).toHaveLength(0);
  });

  test("narrows to one scan from the link in the ready email", async () => {
    const asked: (string | undefined)[] = [];
    stub.reports("fetchReports", (async (scanId?: string) => {
      asked.push(scanId);
      return { reports };
    }) as never);
    renderPage(<ReportsPage />, { route: "/reports?scanId=scan-1" });
    await screen.findByText("Reports for one scan");
    expect(asked).toContain("scan-1");
  });
});

describe("generating a report", () => {
  test("sends the template, format and filters chosen", async () => {
    const requests: CreateReportInput[] = [];
    stub.reports("createReport", (async (input: CreateReportInput) => {
      requests.push(input);
      return { report: aReport({ status: "QUEUED" }) };
    }) as never);

    const user = userEvent.setup();
    renderPage(<GenerateReportDialog scanId="scan-1" />);
    await user.click(screen.getByRole("button", { name: /Generate report/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("radio", { name: /Technical Report/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Open" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Confirmed" }));
    await user.click(within(dialog).getByRole("button", { name: /^Generate$/ }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      scanId: "scan-1",
      template: "TECHNICAL_REPORT",
      format: "PDF",
      triageStates: ["OPEN", "CONFIRMED"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toasts.at(-1)?.kind).toBe("success");
  });

  test("shows why a request was refused", async () => {
    const { ReportApiError } = await import("@/test-support/mocks");
    stub.reports("createReport", (async () => {
      throw new ReportApiError(409, "Reports can only be generated for a completed scan.");
    }) as never);

    const user = userEvent.setup();
    renderPage(<GenerateReportDialog scanId="scan-1" />);
    await user.click(screen.getByRole("button", { name: /Generate report/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Generate$/ }));

    await within(dialog).findByText("Reports can only be generated for a completed scan.");
  });
});

describe("sharing a report", () => {
  test("shows the link once, as an absolute URL", async () => {
    const calls: [string, number][] = [];
    stub.reports("shareReport", (async (id: string, days: number) => {
      calls.push([id, days]);
      return {
        report: aReport({ share: { active: true, expiresAt: "2026-10-12T10:00:00.000Z" } }),
        sharePath: "/api/reports/shared/abc123",
      };
    }) as never);

    const user = userEvent.setup();
    renderPage(<ReportsPage />);
    await user.click(await screen.findByRole("button", { name: /^Share Download/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Create link/ }));

    const input = (await within(dialog).findByLabelText("Share link")) as HTMLInputElement;
    expect(input.value).toBe("http://localhost:3000/api/reports/shared/abc123");
    expect(calls).toEqual([["report-1", 7]]);
    expect(within(dialog).getByText(/will not be shown again/)).toBeTruthy();
  });

  test("an active link can be revoked", async () => {
    reports = [aReport({ share: { active: true, expiresAt: "2026-10-12T10:00:00.000Z" } })];
    const revoked: string[] = [];
    stub.reports("revokeReportShare", (async (id: string) => {
      revoked.push(id);
      return { report: aReport() };
    }) as never);

    const user = userEvent.setup();
    renderPage(<ReportsPage />);
    await user.click(await screen.findByRole("button", { name: /^Share Download/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Revoke link/ }));

    await waitFor(() => expect(revoked).toEqual(["report-1"]));
    expect(toasts).toContainEqual({ kind: "success", message: "Share link revoked" });
  });
});
