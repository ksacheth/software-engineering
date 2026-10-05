import { describe, expect, test } from "bun:test";
import { verificationCodeEmail } from "./email-templates";

describe("verificationCodeEmail", () => {
  const message = verificationCodeEmail({ name: "Ada <b>", code: "482913" });

  test("puts the code in the body and its lifetime beside it", () => {
    expect(message.text).toContain("482913");
    expect(message.text).toContain("expires in 10 minutes");
    expect(message.html).toContain("482913");
    expect(message.kind).toBe("verification");
  });

  test("keeps the code out of the subject, where previews would show it", () => {
    expect(message.subject).not.toContain("482913");
  });

  test("offers nothing to click", () => {
    expect(message.html).not.toContain("<a ");
    expect(message.text).not.toMatch(/https?:\/\//);
  });

  test("escapes the account name in the HTML part", () => {
    expect(message.html).toContain("Ada &lt;b&gt;");
  });
});
