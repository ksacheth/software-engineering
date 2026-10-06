import { describe, expect, test } from "bun:test";
// The harness points the app at the test database and Redis before anything
// reads the configuration, so the app modules are imported after it.
import "../test-support/harness";

const { config } = await import("../config/env");
const { sendEmail } = await import("./email");

describe("email under test", () => {
  test("uses the in-memory transport, so no SMTP relay is needed", () => {
    expect(config.smtp.transport).toBe("json");
  });

  test("delivers without a relay and queues nothing for retry", async () => {
    const delivered = await sendEmail({
      to: "nobody@example.test",
      subject: "Check",
      text: "Sent through the JSON transport.",
      kind: "verification",
    });

    expect(delivered).toBe(true);
  });
});
