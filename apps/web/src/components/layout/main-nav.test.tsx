import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
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
