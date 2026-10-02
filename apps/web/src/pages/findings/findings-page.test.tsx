import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  FindingFilters,
  FindingSummary,
  TriageInput,
} from "@/services/findings";
import { aFinding, aListedTarget } from "@/test-support/fixtures";
import { resetMocks, stub, toasts } from "@/test-support/mocks";
import { currentPath, renderPage } from "@/test-support/render";

/**
 * The current posture (F.6).
 *
 * Filters must reach the server: the list is paged, so a client-side filter
 * would search one page and report nothing for a finding two pages down. The
 * default hides findings judged false positive or accepted, and one control
 * has to bring them back, or a hidden finding is lost to anyone who forgot.
 */

interface Call {
  filters: FindingFilters;
  cursor: string | undefined;
}

const calls: Call[] = [];
let pages: { findings: FindingSummary[]; nextCursor: string | null }[] = [];
let canWrite = true;
const bulkCalls: { ids: string[]; input: TriageInput }[] = [];

const { FindingsPage } = await import("./findings-page");

const lastFilters = () => calls.at(-1)!.filters;

async function renderFindings(findings: FindingSummary[] = []) {
  pages = [{ findings, nextCursor: null }];
  const view = renderPage(<FindingsPage />, { path: "/findings", route: "/findings" });
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  return view;
}

async function choose(filter: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(filter));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  resetMocks();
  calls.length = 0;
  bulkCalls.length = 0;
  pages = [{ findings: [], nextCursor: null }];
  canWrite = true;

  stub.findings("fetchFindings", (async (filters: FindingFilters, cursor?: string) => {
    calls.push({ filters, cursor });
    return pages[cursor ? 1 : 0] ?? { findings: [], nextCursor: null };
  }) as never);
  stub.findings("triageFindings", (async (ids: string[], input: TriageInput) => {
    bulkCalls.push({ ids, input });
    return { updated: ids.length, unchanged: 0 };
  }) as never);
  stub.targets("fetchTargets", (async () => ({
    targets: [aListedTarget({ id: "target-2", label: "Docs site" })],
  })) as never);
  stub.role("useCanWrite", (() => canWrite) as never);
});

describe("the default view", () => {
  test("asks for the posture, leaving the triage default to the server", async () => {
    await renderFindings([aFinding({ name: "Missing HSTS" })]);

    expect(lastFilters().scanId).toBeUndefined();
    expect(lastFilters().triage).toBeUndefined();
    expect(lastFilters()).toMatchObject({ sort: "severity", direction: "desc" });
    expect(await screen.findByRole("link", { name: "Missing HSTS" })).toBeTruthy();
  });

  test("shows severity, target, diff and triage on each row", async () => {
    await renderFindings([
      aFinding({
        name: "SQL Injection",
        severity: "CRITICAL",
        diffStatus: "NEW",
        cvssScore: 9.8,
        triage: { state: "CONFIRMED", justification: null, updatedAt: null, updatedBy: null },
      }),
    ]);

    const row = (await screen.findByRole("link", { name: "SQL Injection" })).closest("tr")!;
    expect(within(row).getByText("Critical")).toBeTruthy();
    expect(within(row).getByText("Corporate site")).toBeTruthy();
    expect(within(row).getByText("New")).toBeTruthy();
    expect(within(row).getByText("Confirmed")).toBeTruthy();
    expect(within(row).getByText("9.8")).toBeTruthy();
  });

  test("explains that judged findings are hidden when nothing matches", async () => {
    await renderFindings([]);

    expect(await screen.findByText(/hidden unless you choose All triage states/)).toBeTruthy();
  });

  test("opens a finding from its row", async () => {
    await renderFindings([aFinding({ id: "f-7", name: "Open Redirect" })]);

    await userEvent.setup().click(await screen.findByText("Open Redirect"));
    expect(currentPath()).toBe("/findings/f-7");
  });
});

describe("filters reach the server", () => {
  test("showing every triage state", async () => {
    await renderFindings();
    await choose("Filter by triage state", "All triage states");

    await waitFor(() => expect(lastFilters().triage).toBe("all"));
  });

  test("a severity toggle", async () => {
    await renderFindings();
    const toggle = within(screen.getByRole("group", { name: "Filter by severity" })).getByRole(
      "button",
      { name: /Critical/ },
    );
    await userEvent.setup().click(toggle);

    await waitFor(() => expect(lastFilters().severities).toEqual(["CRITICAL"]));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("search text, once typing pauses", async () => {
    await renderFindings();
    await userEvent.setup().type(screen.getByLabelText("Search findings by name or URL"), "login");

    await waitFor(() => expect(lastFilters().search).toBe("login"));
  });

  test("a sort, with the direction that suits it", async () => {
    await renderFindings();
    await choose("Sort by", "Name");

    await waitFor(() => expect(lastFilters()).toMatchObject({ sort: "name", direction: "asc" }));
  });

  test("the next page, by cursor", async () => {
    pages = [
      { findings: [aFinding({ id: "a", name: "First" })], nextCursor: "c-1" },
      { findings: [aFinding({ id: "b", name: "Second" })], nextCursor: null },
    ];
    renderPage(<FindingsPage />, { path: "/findings", route: "/findings" });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("link", { name: "Second" })).toBeTruthy();
    expect(calls.at(-1)!.cursor).toBe("c-1");
  });
});

describe("bulk triage", () => {
  const two = () => [
    aFinding({ id: "f-1", fingerprint: "fp-1", name: "Tech fingerprint A" }),
    aFinding({ id: "f-2", fingerprint: "fp-2", name: "Tech fingerprint B" }),
  ];

  test("is not offered to a viewer", async () => {
    canWrite = false;
    await renderFindings(two());
    await screen.findByRole("link", { name: "Tech fingerprint A" });

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  test("records one decision for every selected finding", async () => {
    const user = userEvent.setup();
    await renderFindings(two());
    await user.click(await screen.findByRole("checkbox", { name: "Select all shown findings" }));
    expect(screen.getByText("2 selected")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Set triage…" }));
    await user.click(await screen.findByText("False positive"));
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    // Hiding risk without a reason is refused before it reaches the API.
    expect(await screen.findByText(/A justification is required/)).toBeTruthy();
    expect(bulkCalls).toHaveLength(0);

    await user.type(screen.getByLabelText(/Justification/), "Framework banner only");
    await user.click(screen.getByRole("button", { name: "Record triage" }));

    await waitFor(() => expect(bulkCalls).toHaveLength(1));
    expect(bulkCalls[0]!.ids.sort()).toEqual(["f-1", "f-2"]);
    expect(bulkCalls[0]!.input).toEqual({
      state: "FALSE_POSITIVE",
      justification: "Framework banner only",
    });
    await waitFor(() =>
      expect(toasts).toContainEqual({ kind: "success", message: "Triage recorded for 2 findings" }),
    );
  });
});
