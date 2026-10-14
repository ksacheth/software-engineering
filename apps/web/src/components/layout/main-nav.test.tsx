import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetMocks, stub } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The dashboard chrome's F.8 parts: where administration is offered, and the
 * notice every user sees while scanning is halted.
 */

const { MainNav } = await import("./main-nav");
const { KillSwitchBanner } = await import("./kill-switch-banner");

beforeEach(() => {
  resetMocks();
});

describe("the main navigation", () => {
  test("offers Admin to administrators", () => {
    stub.role("useRole", () => "ADMIN");
    renderPage(<MainNav />);
    expect(screen.getByRole("link", { name: "Admin" })).toBeTruthy();
  });

  test("does not offer Admin to anyone else", () => {
    stub.role("useRole", () => "ANALYST");
    renderPage(<MainNav />);
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    expect(screen.getByRole("link", { name: "Targets" })).toBeTruthy();
  });

  test("leads with the dashboard", () => {
    stub.role("useRole", () => "ANALYST");
    renderPage(<MainNav />);
    const first = screen.getAllByRole("link")[0]!;
    expect(first.textContent).toBe("Dashboard");
    expect(first.getAttribute("href")).toBe("/dashboard");
  });

  test("marks the section you are in, including its sub-pages", () => {
    stub.role("useRole", () => "ANALYST");
    renderPage(<MainNav />, { route: "/targets/target-1" });

    expect(screen.getByRole("link", { name: "Targets" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Scans" }).getAttribute("aria-current")).toBeNull();
  });

  test("folds into a menu that lists the same sections", async () => {
    stub.role("useRole", () => "ADMIN");
    renderPage(<MainNav />, { route: "/dashboard" });

    // Radix opens on pointer-down, which the test DOM does not fully model; the
    // keyboard path is the one a keyboard user takes anyway.
    screen.getByRole("button", { name: "Open navigation" }).focus();
    await userEvent.setup().keyboard("{Enter}");

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Dashboard",
      "Targets",
      "Scans",
      "Findings",
      "Reports",
      "Admin",
    ]);
    expect(items[0]!.getAttribute("href")).toBe("/dashboard");
    expect(items[0]!.getAttribute("aria-current")).toBe("page");
  });
});

describe("the kill switch banner", () => {
  test("tells everyone scanning is halted", () => {
    stub.killSwitch("useKillSwitchEngaged", () => true);
    renderPage(<KillSwitchBanner />);
    expect(screen.getByRole("alert").textContent).toContain(
      "An administrator has halted all scanning",
    );
  });

  test("is absent while scanning runs normally", () => {
    renderPage(<KillSwitchBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
