// @ts-ignore
import { describe, expect, test } from "bun:test";
import { canonicalUrl } from "./canonical-url.js";

describe("canonicalUrl", () => {
  test("removes fragment", () => {
    expect(canonicalUrl("https://example.com/a#test"))
      .toBe("https://example.com/a");
  });

  test("removes tracking parameters", () => {
    expect(canonicalUrl("https://example.com/a?utm_source=x&id=5"))
      .toBe("https://example.com/a?id=5");
  });

  test("removes session parameters", () => {
    expect(canonicalUrl("https://example.com/a?sid=123"))
      .toBe("https://example.com/a");
  });

  test("removes trailing slash", () => {
    expect(canonicalUrl("https://example.com/a/"))
      .toBe("https://example.com/a");
  });
});