import { beforeEach, describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import type { DashboardSummary } from "@/services/dashboard";
import type { Scan } from "@/services/scans";
import { aScan } from "@/test-support/fixtures";
import { resetMocks, stub } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The dashboard overview.
 *
 * Each card summarises a list page and links to it, so the tests check the
 * arithmetic the page does on the server's counts and that every number leads
 * somewhere. A new organisation has nothing to summarise and is shown the way
 * in instead of a wall of zeros.
 */

const { DashboardPage } = await import("./dashboard-page");

function aSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    targets: { total: 3, scannable: 2 },
    scans: {
      QUEUED: 1,
      RUNNING: 2,
      PAUSED: 1,
      COMPLETED: 7,
      FAILED: 1,
      CANCELLED: 1,
      ABORTED_SAFETY: 1,
    },
    findings: { CRITICAL: 2, HIGH: 3, MEDIUM: 5, LOW: 1, INFO: 4 },
    ...overrides,
  };
}

function renderDashboard(summary: DashboardSummary, scans: Scan[] = []) {
  stub.dashboard("fetchDashboardSummary", async () => ({ summary }));
  stub.scans("fetchScans", async () => ({ scans, nextCursor: null }));
  return renderPage(<DashboardPage />, { path: "/dashboard", route: "/dashboard" });
}

/** The stat card whose link carries this label. */
async function card(label: string) {
  const link = (await screen.findByText(label)).closest("a");
  expect(link).toBeTruthy();
  return link!;
}

beforeEach(() => {
  resetMocks();
});

describe("the dashboard", () => {
  test("totals the summary into the four headline cards", async () => {
    renderDashboard(aSummary());

    const targets = await card("Targets");
    expect(targets.getAttribute("href")).toBe("/targets");
    expect(targets.textContent).toContain("3");
    expect(targets.textContent).toContain("2 ready to scan");

    const active = await card("Scans in progress");
    expect(active.textContent).toContain("4"); // queued + running + paused
    expect(active.textContent).toContain("1 queued, 1 paused");

    const completed = await card("Completed scans");
    expect(completed.textContent).toContain("7");
    expect(completed.textContent).toContain("3 failed or stopped");

    const findings = await card("Open findings");
    expect(findings.getAttribute("href")).toBe("/findings");
    expect(findings.textContent).toContain("15");
    expect(findings.textContent).toContain("5 critical or high");
  });

  test("breaks the open findings down by severity", async () => {
    renderDashboard(aSummary());

    const breakdown = (await screen.findByText("Findings by severity")).closest(
      "[data-slot=card]",
    ) as HTMLElement;
    const rows = within(breakdown).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Critical2",
      "High3",
      "Medium5",
      "Low1",
      "Info4",
    ]);
  });

  test("lists the five most recent scans, each linking to its page", async () => {
    const scans = Array.from({ length: 7 }, (_, index) =>
      aScan({
        id: `scan-${index}`,
        target: { id: "t", label: `Site ${index}`, origin: "https://a.test" },
      }),
    );
    renderDashboard(aSummary(), scans);

    expect((await screen.findByRole("link", { name: "Site 0" })).getAttribute("href")).toBe(
      "/scans/scan-0",
    );
    expect(screen.getByRole("link", { name: "Site 4" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Site 5" })).toBeNull();
  });

  test("says so when there are no open findings", async () => {
    renderDashboard(
      aSummary({ findings: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 } }),
    );
    expect(await screen.findByText("No open findings.")).toBeTruthy();
  });

  test("shows a new organisation how to start instead of zeros", async () => {
    renderDashboard(aSummary({ targets: { total: 0, scannable: 0 } }));

    expect(await screen.findByText("Scan your first website")).toBeTruthy();
    expect(screen.queryByText("Open findings")).toBeNull();
    const starts = screen.getAllByRole("link", { name: "Register a target" });
    expect(starts.every((link) => link.getAttribute("href") === "/targets")).toBe(true);
  });

  test("reports a failure to load", async () => {
    stub.dashboard("fetchDashboardSummary", async () => {
      throw new Error("The dashboard request failed with status 500");
    });
    renderPage(<DashboardPage />, { path: "/dashboard", route: "/dashboard" });

    expect(await screen.findByText("The dashboard could not be loaded")).toBeTruthy();
  });
});
