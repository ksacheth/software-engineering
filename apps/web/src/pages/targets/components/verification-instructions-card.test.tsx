import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Target, VerificationInstructions } from "@/services/targets";
import {
  aTarget,
  dnsInstructions,
  wellKnownInstructions,
} from "@/test-support/fixtures";
import { resetMocks, stub, TargetApiError, toasts } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The ownership challenge (F.2).
 *
 * Everything the user has to copy into their DNS zone or their web root is
 * shown here, and it has to be exact: a token with a stray space fails the
 * challenge with a message that blames the record rather than the copy. The
 * fields are read-only for that reason, and each carries its own copy control.
 *
 * The other half is the refusal. Verification is rate limited per target and
 * per organisation, so a user who retries in frustration meets a 429 rather
 * than a challenge result. The cooldown is shown as a countdown and the button
 * is closed for its duration, because the alternative is a user who believes
 * the challenge keeps failing when it has not been run.
 */

/** Intervals the component started, so the countdown can be driven by hand. */
const intervals = new Map<number, () => void>();
let nextIntervalId = 1;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

const attempts: string[] = [];
let verifyFails: Error | null = null;
const verified: unknown[] = [];

const { VerificationInstructionsCard } = await import(
  "./verification-instructions-card"
);

function renderCard({
  target = aTarget({ verificationStatus: "UNVERIFIED", verifiedAt: null }),
  instructions = dnsInstructions(),
  scannable = { scannable: false, reason: "NOT_VERIFIED" as const },
}: {
  target?: Target;
  instructions?: VerificationInstructions;
  scannable?: { scannable: boolean; reason?: "NOT_VERIFIED" };
} = {}) {
  return renderPage(
    <VerificationInstructionsCard
      target={target}
      instructions={instructions}
      scannable={scannable}
      onVerified={(data) => verified.push(data)}
    />,
  );
}

const verifyButton = () =>
  screen.getByRole("button", { name: /^Verify/ });

/**
 * Run one second of the component's countdown.
 *
 * Inside `act`, because the ticker sets state: React would otherwise warn that
 * the update escaped, and the re-render would not have happened by the time the
 * next line asserts on it.
 */
function tick(seconds = 1) {
  act(() => {
    for (let i = 0; i < seconds; i += 1) {
      for (const run of [...intervals.values()]) run();
    }
  });
}

beforeEach(() => {
  resetMocks();
  attempts.length = 0;
  verified.length = 0;
  verifyFails = null;
  intervals.clear();

  // Only the one-second ticker is taken over. Anything else that wants a timer
  // keeps the real one, so a stray interval cannot be driven by `tick`.
  globalThis.setInterval = ((handler: TimerHandler, delay?: number) => {
    if (delay !== 1000 || typeof handler !== "function") {
      return realSetInterval(handler as never, delay as never);
    }
    const id = nextIntervalId++;
    intervals.set(id, handler as () => void);
    return id;
  }) as unknown as typeof globalThis.setInterval;

  globalThis.clearInterval = ((id: number) => {
    if (!intervals.delete(id)) realClearInterval(id);
  }) as unknown as typeof globalThis.clearInterval;

  stub.targets("verifyTarget", (async (id: string) => {
    attempts.push(id);
    if (verifyFails) throw verifyFails;
    return {
      target: aTarget({ verificationStatus: "VERIFIED" }),
      scannable: { scannable: true },
    };
  }) as never);
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

describe("the DNS challenge", () => {
  test("shows the record exactly as it has to be created", async () => {
    const instructions = dnsInstructions();
    renderCard({ instructions });

    expect(
      (screen.getByLabelText("Record Name") as HTMLInputElement).value,
    ).toBe("_wvs-challenge.a.test");
    expect(
      (screen.getByLabelText("Record Type") as HTMLInputElement).value,
    ).toBe("TXT");
    expect(
      (screen.getByLabelText(/Record Value/) as HTMLInputElement).value,
    ).toBe((instructions as { recordValue: string }).recordValue);
  });

  test("will not let the token be edited in place", async () => {
    // The field is the user's copy of a CSPRNG token. A value edited here would
    // be copied out and fail the challenge against a record that is correct.
    renderCard();

    expect(
      (screen.getByLabelText(/Record Value/) as HTMLInputElement).readOnly,
    ).toBe(true);
  });

  test("copies the token rather than making the user select it", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Copy Token" }));

    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "wvs-verify-0123456789abcdef",
      ),
    );
    expect(toasts).toContainEqual({
      kind: "success",
      message: "Copied to clipboard",
    });
  });
});

describe("the well-known challenge", () => {
  test("shows the URL and the file content, and nothing about DNS", async () => {
    renderCard({ instructions: wellKnownInstructions() });

    expect(
      (screen.getByLabelText("Verification URL") as HTMLInputElement).value,
    ).toBe("https://a.test/.well-known/wvs-verify.txt");
    expect(
      (screen.getByLabelText(/File Content/) as HTMLInputElement).value,
    ).toBe("wvs-verify-0123456789abcdef");
    expect(screen.queryByLabelText("Record Name")).toBeNull();
  });

  test("links to the file so the user can check what they served", async () => {
    renderCard({ instructions: wellKnownInstructions() });

    expect(
      screen.getByRole("link", { name: /Open/ }).getAttribute("href"),
    ).toBe("https://a.test/.well-known/wvs-verify.txt");
  });
});

describe("running the challenge", () => {
  test("asks the API to verify this target", async () => {
    renderCard();

    await userEvent.setup().click(verifyButton());

    await waitFor(() => expect(attempts).toEqual(["target-1"]));
  });

  test("reports success and hands the result back to the page", async () => {
    // The page above decides what to show once a target is verified, and it
    // cannot do that from a toast.
    renderCard();

    await userEvent.setup().click(verifyButton());

    await waitFor(() => expect(screen.getByText("Target Verified")).toBeTruthy());
    expect(verified).toHaveLength(1);
    expect(toasts).toContainEqual({
      kind: "success",
      message: "Target ownership verified successfully!",
    });
  });

  test("says a target is verified before the user runs anything", async () => {
    // Re-running a challenge that has already passed is wasted effort against a
    // rate limit, so the state has to be visible on arrival.
    renderCard({
      target: aTarget({ verificationStatus: "VERIFIED" }),
      scannable: { scannable: true },
    });

    expect(screen.getByText("Target Verified")).toBeTruthy();
    expect(attempts).toHaveLength(0);
  });

  test("does not call a verified but unscannable target verified", async () => {
    // A verified target with no recorded addresses fails closed under ADR-0004.
    // Claiming the IP set is committed would contradict the verdict beside it.
    renderCard({
      target: aTarget({ verificationStatus: "VERIFIED" }),
      scannable: { scannable: false, reason: "NOT_VERIFIED" },
    });

    expect(screen.queryByText("Target Verified")).toBeNull();
  });
});

describe("when the challenge fails", () => {
  test("shows what the API said, word for word", async () => {
    // The API knows which record it looked up and what it found. Replacing that
    // with a generic failure leaves the user guessing at their own zone.
    verifyFails = new TargetApiError(
      422,
      "No TXT record found at _wvs-challenge.a.test.",
    );
    renderCard();

    await userEvent.setup().click(verifyButton());

    await waitFor(() =>
      expect(
        screen.getByText("No TXT record found at _wvs-challenge.a.test."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Verification Failed (422)")).toBeTruthy();
  });

  test("leaves the button usable so the record can be fixed and retried", async () => {
    verifyFails = new TargetApiError(422, "Token mismatch.");
    renderCard();

    await userEvent.setup().click(verifyButton());

    await waitFor(() => expect(screen.getByText("Token mismatch.")).toBeTruthy());
    expect(verifyButton().hasAttribute("disabled")).toBe(false);
  });

  test("still says something when the failure is not from the API", async () => {
    verifyFails = new Error("Failed to fetch");
    renderCard();

    await userEvent.setup().click(verifyButton());

    await waitFor(() =>
      expect(screen.getByText("Failed to fetch")).toBeTruthy(),
    );
  });
});

describe("when verification is throttled", () => {
  /** A 429 as the API sends it, carrying the wait in the problem document. */
  const throttled = (retryAfterSeconds: number) =>
    new TargetApiError(429, "Too many verification attempts.", {
      kind: "TOO_SOON",
      retryAfterSeconds,
    });

  async function beThrottled(retryAfterSeconds = 30) {
    verifyFails = throttled(retryAfterSeconds);
    renderCard();
    await userEvent.setup().click(verifyButton());
    await waitFor(() =>
      expect(screen.getByText("Verification Throttled (429)")).toBeTruthy(),
    );
  }

  test("closes the button for exactly as long as the API asked", async () => {
    // Retrying inside the cooldown does not run a challenge, it earns another
    // refusal and, per the hourly quota, spends an attempt.
    await beThrottled(30);

    expect(verifyButton().hasAttribute("disabled")).toBe(true);
    expect(verifyButton().textContent).toContain("wait 30s");
  });

  test("counts down so the wait is visible", async () => {
    await beThrottled(3);

    tick(2);

    await waitFor(() => expect(verifyButton().textContent).toContain("wait 1s"));
  });

  test("opens the button again once the wait is over", async () => {
    await beThrottled(2);

    tick(2);

    await waitFor(() =>
      expect(verifyButton().hasAttribute("disabled")).toBe(false),
    );
    expect(verifyButton().textContent).toContain("Verify ownership");
  });

  test("does not run a challenge while the cooldown is on", async () => {
    await beThrottled(30);
    const attemptsSoFar = attempts.length;

    await userEvent.setup().click(verifyButton()).catch(() => {});

    expect(attempts).toHaveLength(attemptsSoFar);
  });

  test("assumes a wait when the API does not name one", async () => {
    // A 429 with no `retryAfterSeconds` would otherwise leave the button open
    // and the user in a retry loop against the rate limiter.
    verifyFails = new TargetApiError(429, "Too many verification attempts.");
    renderCard();

    await userEvent.setup().click(verifyButton());

    await waitFor(() =>
      expect(verifyButton().hasAttribute("disabled")).toBe(true),
    );
    expect(verifyButton().textContent).toMatch(/wait \d+s/);
  });
});
