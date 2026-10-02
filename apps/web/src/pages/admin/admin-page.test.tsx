import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AdminOrganization,
  AdminUser,
  AuditEntry,
  BlocklistEntry,
  Health,
  KillSwitch,
} from "@/services/admin";
import { AdminApiError, resetMocks, stub, toasts } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The administration area (F.8, ADR-0009).
 *
 * The API is the enforcer: every endpoint behind it checks the role and 2FA,
 * so these tests are about what an administrator can see and do, and that the
 * two actions with the widest blast radius (the kill switch and suspension)
 * cannot be taken by a stray click.
 */

const { AdminPage } = await import("./admin-page");

const ISO = "2026-09-21T10:00:00.000Z";

const released: KillSwitch = {
  engaged: false,
  changedAt: null,
  reason: null,
  changedBy: null,
};

const healthy: Health = {
  database: { ok: true },
  redis: { ok: true },
  queue: { waiting: 1, active: 2, delayed: 0, failed: 0 },
  scans: { QUEUED: 1, RUNNING: 2, PAUSED: 0 },
  killSwitch: { engaged: false },
  email: { pending: 0, deadLettered: 0, oldestPendingAt: null },
};

function aUser(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "user-2",
    name: "Alice",
    email: "alice@example.test",
    emailVerified: true,
    role: "ANALYST",
    twoFactorEnabled: false,
    suspendedAt: null,
    lockedUntil: null,
    createdAt: ISO,
    organization: { id: "org-2", name: "Alice's Organization" },
    lastSignInAt: ISO,
    ...overrides,
  };
}

let killSwitch: KillSwitch;
const calls: { fn: string; args: unknown[] }[] = [];

function record(fn: string, result: (...args: never[]) => unknown) {
  return (async (...args: never[]) => {
    calls.push({ fn, args });
    return result(...args);
  }) as never;
}

const called = (fn: string) => calls.filter((c) => c.fn === fn);

function renderAdmin(section = "") {
  return renderPage(<AdminPage />, {
    path: "/admin/*",
    route: `/admin${section ? `/${section}` : ""}`,
  });
}

beforeEach(() => {
  resetMocks();
  calls.length = 0;
  killSwitch = released;
  stub.role("useRole", () => "ADMIN");
  stub.role("useMe", () => ({ user: { id: "user-1" } }));
  stub.admin(
    "fetchKillSwitch",
    record("fetchKillSwitch", () => ({ killSwitch })),
  );
  stub.admin("fetchHealth", record("fetchHealth", () => healthy));
  stub.admin(
    "engageKillSwitch",
    record("engageKillSwitch", () => ({
      killSwitch: { ...released, engaged: true },
      abortedScans: 3,
    })),
  );
  stub.admin(
    "releaseKillSwitch",
    record("releaseKillSwitch", () => ({ killSwitch: released })),
  );
});

describe("who can see it", () => {
  test("anyone who is not an administrator is told so, and nothing is fetched", async () => {
    stub.role("useRole", () => "ANALYST");
    renderAdmin();

    expect(await screen.findByText("Administrators only")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  test("an administrator without 2FA is sent to set it up", async () => {
    stub.admin("fetchKillSwitch", (async () => {
      throw new AdminApiError(403, "Administration requires two-factor authentication.", {
        code: "TWO_FACTOR_REQUIRED",
      });
    }) as never);
    renderAdmin();

    expect(await screen.findByText("Two-factor authentication required")).toBeTruthy();
    const link = screen.getByRole("link", { name: /security settings/i });
    expect(link.getAttribute("href")).toBe("/settings/security");
  });
});

describe("the kill switch", () => {
  test("says scanning is running when it is released", async () => {
    renderAdmin();
    expect(await screen.findByText("Scanning is running")).toBeTruthy();
  });

  test("cannot be engaged without a reason and the typed confirmation", async () => {
    const user = userEvent.setup();
    renderAdmin();

    await user.click(await screen.findByRole("button", { name: "Engage kill switch" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Halt all scans" });

    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.type(within(dialog).getByLabelText("Reason"), "Runaway scan");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.type(within(dialog).getByLabelText(/Type HALT/), "HALT");
    expect(confirm.hasAttribute("disabled")).toBe(false);

    await user.click(confirm);

    await waitFor(() => expect(called("engageKillSwitch")).toHaveLength(1));
    expect(called("engageKillSwitch")[0]!.args).toEqual(["Runaway scan"]);
    await waitFor(() =>
      expect(toasts).toContainEqual({
        kind: "success",
        message: "Kill switch engaged. 3 scans aborted.",
      }),
    );
  });

  test("when engaged, shows who engaged it and why, and can be released with a reason", async () => {
    killSwitch = {
      engaged: true,
      changedAt: ISO,
      reason: "Investigating an incident",
      changedBy: { id: "user-9", email: "ops@example.test", name: "Ops" },
    };
    const user = userEvent.setup();
    renderAdmin();

    expect(await screen.findByText("Scanning is halted")).toBeTruthy();
    expect(screen.getByText(/Investigating an incident/)).toBeTruthy();
    expect(screen.getByText(/ops@example.test/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Release kill switch" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Resolved");
    await user.click(within(dialog).getByRole("button", { name: "Release" }));

    await waitFor(() => expect(called("releaseKillSwitch")).toHaveLength(1));
    expect(called("releaseKillSwitch")[0]!.args).toEqual(["Resolved"]);
  });

  test("a confirmation never carries over to the next engage or release", async () => {
    stub.admin(
      "engageKillSwitch",
      record("engageKillSwitch", () => {
        killSwitch = { ...released, engaged: true };
        return { killSwitch, abortedScans: 0 };
      }),
    );
    stub.admin(
      "releaseKillSwitch",
      record("releaseKillSwitch", () => {
        killSwitch = released;
        return { killSwitch };
      }),
    );
    const user = userEvent.setup();
    renderAdmin();

    await user.click(await screen.findByRole("button", { name: "Engage kill switch" }));
    let dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Runaway scan");
    await user.type(within(dialog).getByLabelText(/Type HALT/), "HALT");
    await user.click(within(dialog).getByRole("button", { name: "Halt all scans" }));

    await user.click(await screen.findByRole("button", { name: "Release kill switch" }));
    dialog = await screen.findByRole("alertdialog");
    expect((within(dialog).getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("");
    await user.type(within(dialog).getByLabelText("Reason"), "Resolved");
    await user.click(within(dialog).getByRole("button", { name: "Release" }));

    await user.click(await screen.findByRole("button", { name: "Engage kill switch" }));
    dialog = await screen.findByRole("alertdialog");
    expect((within(dialog).getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("");
    expect((within(dialog).getByLabelText(/Type HALT/) as HTMLInputElement).value).toBe("");
    expect(
      within(dialog).getByRole("button", { name: "Halt all scans" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("health", () => {
  test("shows each probe, and names the one that is down", async () => {
    stub.admin("fetchHealth", (async () => ({
      ...healthy,
      redis: { ok: false, error: "connect ECONNREFUSED" },
    })) as never);
    renderAdmin();

    const database = await screen.findByTestId("health-database");
    expect(database.textContent).toContain("OK");
    const redis = screen.getByTestId("health-redis");
    expect(redis.textContent).toContain("Unavailable");
    expect(redis.textContent).toContain("ECONNREFUSED");
  });
});

describe("accounts", () => {
  beforeEach(() => {
    stub.admin(
      "fetchUsers",
      record("fetchUsers", () => ({
        users: [
          aUser({ id: "user-1", email: "me@example.test", role: "ADMIN", twoFactorEnabled: true }),
          aUser(),
          aUser({ id: "user-3", email: "sus@example.test", suspendedAt: ISO }),
        ],
        nextCursor: null,
      })),
    );
    stub.admin(
      "changeUserRole",
      record("changeUserRole", () => ({ user: aUser({ role: "VIEWER" }) })),
    );
    stub.admin("suspendUser", record("suspendUser", () => ({ user: aUser({ suspendedAt: ISO }) })));
    stub.admin("unsuspendUser", record("unsuspendUser", () => ({ user: aUser() })));
  });

  const rowFor = (email: string) => screen.getByText(email).closest("tr")!;

  test("lists every account with its organisation, role, 2FA and suspension", async () => {
    renderAdmin("users");

    await screen.findByText("alice@example.test");
    const alice = rowFor("alice@example.test");
    expect(alice.textContent).toContain("Alice's Organization");
    expect(within(rowFor("sus@example.test")).getByText("Suspended")).toBeTruthy();
  });

  test("offers no actions on your own account", async () => {
    renderAdmin("users");

    await screen.findByText("me@example.test");
    expect(within(rowFor("me@example.test")).queryByRole("button")).toBeNull();
    expect(within(rowFor("me@example.test")).queryByRole("combobox")).toBeNull();
  });

  test("changes a role", async () => {
    const user = userEvent.setup();
    renderAdmin("users");

    await screen.findByText("alice@example.test");
    await user.click(screen.getByLabelText("Role for alice@example.test"));
    await user.click(await screen.findByRole("option", { name: "VIEWER" }));

    await waitFor(() => expect(called("changeUserRole")).toHaveLength(1));
    expect(called("changeUserRole")[0]!.args).toEqual(["user-2", "VIEWER"]);
  });

  test("suspends only with a reason", async () => {
    const user = userEvent.setup();
    renderAdmin("users");

    await screen.findByText("alice@example.test");
    await user.click(within(rowFor("alice@example.test")).getByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Suspend account" });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    await user.type(within(dialog).getByLabelText("Reason"), "Scanning without consent");
    await user.click(confirm);

    await waitFor(() => expect(called("suspendUser")).toHaveLength(1));
    expect(called("suspendUser")[0]!.args).toEqual(["user-2", "Scanning without consent"]);
  });

  test("searches by what was typed", async () => {
    const user = userEvent.setup();
    renderAdmin("users");

    await screen.findByText("alice@example.test");
    await user.type(screen.getByLabelText("Search accounts"), "alice");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(called("fetchUsers").at(-1)!.args[0]).toBe("alice"),
    );
  });
});

describe("organisations and quotas", () => {
  const acme: AdminOrganization = {
    id: "org-2",
    name: "Acme",
    slug: "acme",
    createdAt: ISO,
    memberCount: 3,
    activeScans: 1,
    maxConcurrentScans: 2,
    scanRateLimit: 10,
  };

  beforeEach(() => {
    stub.admin(
      "fetchOrganizations",
      record("fetchOrganizations", () => ({ organizations: [acme] })),
    );
    stub.admin(
      "updateQuota",
      record("updateQuota", () => ({
        organization: { maxConcurrentScans: 0, scanRateLimit: 5 },
      })),
    );
  });

  test("shows each organisation's quota and usage", async () => {
    renderAdmin("organizations");

    const row = (await screen.findByText("Acme")).closest("tr")!;
    expect(row.textContent).toContain("1 / 2");
    expect(row.textContent).toContain("10 req/s");
  });

  test("saves a new quota, where zero suspends scanning", async () => {
    const user = userEvent.setup();
    renderAdmin("organizations");

    await screen.findByText("Acme");
    await user.click(screen.getByRole("button", { name: "Edit quota for Acme" }));
    const dialog = await screen.findByRole("dialog");
    const concurrent = within(dialog).getByLabelText("Concurrent scans");
    await user.clear(concurrent);
    await user.type(concurrent, "0");
    const rate = within(dialog).getByLabelText("Request rate (req/s)");
    await user.clear(rate);
    await user.type(rate, "5");
    expect(within(dialog).getByText(/suspends scanning/i)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save quota" }));

    await waitFor(() => expect(called("updateQuota")).toHaveLength(1));
    expect(called("updateQuota")[0]!.args).toEqual([
      "org-2",
      { maxConcurrentScans: 0, scanRateLimit: 5 },
    ]);
  });

  test("a blank field is not saved as zero", async () => {
    const user = userEvent.setup();
    renderAdmin("organizations");

    await screen.findByText("Acme");
    await user.click(screen.getByRole("button", { name: "Edit quota for Acme" }));
    const dialog = await screen.findByRole("dialog");
    const concurrent = within(dialog).getByLabelText("Concurrent scans");
    await user.clear(concurrent);
    expect((concurrent as HTMLInputElement).checkValidity()).toBe(false);
    expect(within(dialog).queryByText(/^Zero suspends/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save quota" }));

    expect(called("updateQuota")).toHaveLength(0);
  });
});

describe("the network blocklist", () => {
  const entry: BlocklistEntry = {
    id: "b1",
    pattern: "gov.example",
    patternType: "HOST_SUFFIX",
    reason: "Government",
    isActive: true,
    createdAt: ISO,
    updatedAt: ISO,
    createdBy: { id: "user-1", email: "me@example.test", name: "Me" },
  };

  beforeEach(() => {
    stub.admin("fetchBlocklist", record("fetchBlocklist", () => ({ entries: [entry] })));
    stub.admin("createBlocklistEntry", record("createBlocklistEntry", () => ({ entry })));
    stub.admin(
      "updateBlocklistEntry",
      record("updateBlocklistEntry", () => ({ entry: { ...entry, isActive: false } })),
    );
    stub.admin("deleteBlocklistEntry", record("deleteBlocklistEntry", () => undefined));
  });

  test("lists entries with who added them", async () => {
    renderAdmin("blocklist");

    const row = (await screen.findByText("gov.example")).closest("tr")!;
    expect(row.textContent).toContain("Government");
    expect(row.textContent).toContain("me@example.test");
  });

  test("adds an entry", async () => {
    const user = userEvent.setup();
    renderAdmin("blocklist");

    await screen.findByText("gov.example");
    await user.click(screen.getByLabelText("Pattern type"));
    await user.click(await screen.findByRole("option", { name: /CIDR/ }));
    await user.type(screen.getByLabelText("Pattern"), "10.0.0.0/8");
    await user.type(screen.getByLabelText("Why is it blocked?"), "Internal");
    await user.click(screen.getByRole("button", { name: "Add to blocklist" }));

    await waitFor(() => expect(called("createBlocklistEntry")).toHaveLength(1));
    expect(called("createBlocklistEntry")[0]!.args).toEqual([
      { patternType: "CIDR", pattern: "10.0.0.0/8", reason: "Internal" },
    ]);
  });

  test("shows what the API says is wrong with a pattern", async () => {
    stub.admin("createBlocklistEntry", (async () => {
      throw new AdminApiError(400, "Validation failed", {
        errors: [{ pointer: "/pattern", detail: "pattern must be an address and prefix" }],
      });
    }) as never);
    const user = userEvent.setup();
    renderAdmin("blocklist");

    await screen.findByText("gov.example");
    await user.type(screen.getByLabelText("Pattern"), "nonsense");
    await user.type(screen.getByLabelText("Why is it blocked?"), "x");
    await user.click(screen.getByRole("button", { name: "Add to blocklist" }));

    expect(await screen.findByText("pattern must be an address and prefix")).toBeTruthy();
  });

  test("deactivates an entry", async () => {
    const user = userEvent.setup();
    renderAdmin("blocklist");

    await screen.findByText("gov.example");
    await user.click(screen.getByLabelText("Active: gov.example"));

    await waitFor(() => expect(called("updateBlocklistEntry")).toHaveLength(1));
    expect(called("updateBlocklistEntry")[0]!.args).toEqual(["b1", { isActive: false }]);
  });

  test("deletes an entry after confirming", async () => {
    const user = userEvent.setup();
    renderAdmin("blocklist");

    await screen.findByText("gov.example");
    await user.click(screen.getByRole("button", { name: "Delete gov.example" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete entry" }));

    await waitFor(() => expect(called("deleteBlocklistEntry")).toHaveLength(1));
  });
});

describe("the audit log", () => {
  function anEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
      id: "a1",
      timestamp: ISO,
      action: "ADMIN_KILL_SWITCH_ENGAGED",
      organizationId: null,
      userId: "user-1",
      ipAddress: "203.0.113.4",
      resourceType: "system_setting",
      resourceId: "scan.kill_switch",
      metadata: { reason: "Runaway scan" },
      user: { id: "user-1", email: "me@example.test", name: "Me" },
      organization: null,
      ...overrides,
    };
  }

  test("lists records with their actor and details", async () => {
    stub.admin(
      "fetchAudit",
      record("fetchAudit", () => ({ entries: [anEntry()], nextCursor: null })),
    );
    renderAdmin("audit");

    const row = (
      await screen.findByRole("cell", { name: "ADMIN_KILL_SWITCH_ENGAGED" })
    ).closest("tr")!;
    expect(row.textContent).toContain("me@example.test");
    expect(row.textContent).toContain("Runaway scan");
  });

  test("filters by action", async () => {
    stub.admin(
      "fetchAudit",
      record("fetchAudit", () => ({ entries: [anEntry()], nextCursor: null })),
    );
    const user = userEvent.setup();
    renderAdmin("audit");

    await screen.findByRole("cell", { name: "ADMIN_KILL_SWITCH_ENGAGED" });
    await user.click(screen.getByLabelText("Filter by action"));
    await user.click(await screen.findByRole("option", { name: "SCAN_QUEUED" }));

    await waitFor(() =>
      expect(called("fetchAudit").at(-1)!.args[0]).toMatchObject({ action: "SCAN_QUEUED" }),
    );
  });

  test("loads older records with the cursor", async () => {
    let page = 0;
    stub.admin(
      "fetchAudit",
      record("fetchAudit", () =>
        page++ === 0
          ? { entries: [anEntry()], nextCursor: "next-1" }
          : { entries: [anEntry({ id: "a2", action: "SCAN_QUEUED" })], nextCursor: null },
      ),
    );
    const user = userEvent.setup();
    renderAdmin("audit");

    await screen.findByRole("cell", { name: "ADMIN_KILL_SWITCH_ENGAGED" });
    await user.click(screen.getByRole("button", { name: "Load older" }));

    expect(await screen.findByRole("cell", { name: "SCAN_QUEUED" })).toBeTruthy();
    expect(called("fetchAudit").at(-1)!.args[1]).toBe("next-1");
  });
});
