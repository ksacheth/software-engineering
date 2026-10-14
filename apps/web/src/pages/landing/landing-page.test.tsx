import { beforeEach, describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import { resetMocks, stub } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The public landing page: the first thing a visitor sees, before any
 * session exists. It has to explain the product and lead a visitor to
 * register or sign in, and a visitor who is already signed in should be sent
 * on to their dashboard rather than asked to sign in again.
 */

const { LandingPage } = await import("./landing-page");

const renderLanding = () => renderPage(<LandingPage />, { path: "/", route: "/" });

const hrefs = (name: string) =>
  screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));

beforeEach(() => {
  resetMocks();
});

describe("the landing page", () => {
  test("introduces the product", () => {
    stub.role("useSignedIn", () => false);
    renderLanding();

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Find the weaknesses in your website before attackers do.",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How it works" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A detection tool, not an attack tool" })).toBeTruthy();
  });

  test("walks through the four steps from website to report", () => {
    stub.role("useSignedIn", () => false);
    renderLanding();

    const steps = screen.getByRole("heading", { name: "How it works" }).nextElementSibling as HTMLElement;
    expect(within(steps).getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Register your website",
      "Prove you own it",
      "Run a scan",
      "Fix and report",
    ]);
  });

  test("offers a visitor registration and sign-in", () => {
    stub.role("useSignedIn", () => false);
    renderLanding();

    expect(hrefs("Register")).toEqual(["/auth/sign-up"]);
    expect(hrefs("Create an account")).toEqual(["/auth/sign-up"]);
    expect(hrefs("Sign in").every((href) => href === "/auth/sign-in")).toBe(true);
    expect(screen.queryByRole("link", { name: "Go to dashboard" })).toBeNull();
  });

  test("sends a signed-in user to the dashboard instead", () => {
    stub.role("useSignedIn", () => true);
    renderLanding();

    expect(hrefs("Go to dashboard").every((href) => href === "/dashboard")).toBe(true);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Register" })).toBeNull();
  });

  test("ends with the project footer", () => {
    stub.role("useSignedIn", () => false);
    renderLanding();

    expect(screen.getByRole("contentinfo").textContent).toContain("Project Team");
  });
});
