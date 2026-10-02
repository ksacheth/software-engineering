import { describe, expect, test } from "bun:test";
import { probe } from "./health";

/**
 * A probe reports its own failure, including one that never settles, so a
 * hung store cannot hold up the rest of the health view.
 */

describe("probe", () => {
  test("passes a result through", async () => {
    expect(await probe(async () => ({ ok: true }))).toEqual({ ok: true });
  });

  test("reports a rejection as that probe's failure", async () => {
    const result = await probe(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(result).toEqual({ ok: false, error: "connect ECONNREFUSED" });
  });

  test("reports a check that never settles as timed out", async () => {
    const result = await probe(() => new Promise(() => {}), 20);
    expect(result).toEqual({ ok: false, error: "Timed out after 20 ms" });
  });
});
