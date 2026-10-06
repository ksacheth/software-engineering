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

  test("keeps the trailing slash so /dir and /dir/ stay distinct", () => {
    expect(canonicalUrl("https://example.com/a/"))
      .toBe("https://example.com/a/");
    expect(canonicalUrl("https://example.com/a"))
      .not.toBe(canonicalUrl("https://example.com/a/"));
  });

  test("sorts query parameters so reordered URLs share a key", () => {
    expect(canonicalUrl("https://example.com/a?b=2&a=1"))
      .toBe(canonicalUrl("https://example.com/a?a=1&b=2"));
  });
});