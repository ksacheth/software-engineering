import { beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Target } from "@/services/targets";
import { aTarget as target } from "@/test-support/fixtures";
import { resetMocks, stub, TargetApiError, toasts } from "@/test-support/mocks";

/**
 * The scope editor (F.2).
 *
 * Scope decides what the crawler is allowed to touch, so the rules it enforces
 * are the same ones the API enforces: a prefix is absolute and bounded. The UI
 * copy of a rule is a courtesy rather than a control, but a copy that drifts is
 * worse than none, because it rejects what the API would accept or promises
 * that something will be saved when it will not.
 *
 * Driven through the keyboard throughout. SRS §3.2.1 requires the dashboard to
 * be operable without a mouse, and adding a path by pressing Enter is the part
 * of that most likely to be broken by a refactor.
 */

const saved: Array<{ includedPaths: string[]; excludedPaths: string[] }> = [];
let saveFails = false;

const { ScopeEditor } = await import("./scope-editor");

function renderEditor(value: Target = target()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ScopeEditor target={value} />, { wrapper });
}

const includedField = () => screen.getByLabelText("Included Path Prefixes");
const excludedField = () => screen.getByLabelText("Excluded Path Prefixes");
const saveButton = () => screen.getByRole("button", { name: /Save Scope/ });

/**
 * Type a path and commit it with Enter, as a keyboard user would.
 *
 * The box is cleared first because a rejected path is deliberately left in it,
 * so a second attempt would otherwise be typed onto the end of the first.
 */
async function addPath(field: HTMLElement, path: string) {
  const user = userEvent.setup();
  await user.clear(field);
  await user.click(field);
  await user.keyboard(path);
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  resetMocks();
  saved.length = 0;
  saveFails = false;
  stub.targets("updateTargetScope", (async (
    _id: string,
    scope: { includedPaths: string[]; excludedPaths: string[] },
  ) => {
    if (saveFails) throw new TargetApiError(422, "Scope rejected by the API.");
    saved.push(scope);
    return { target: {} };
  }) as never);
});

describe("adding a path", () => {
  test("accepts an absolute prefix", async () => {
    renderEditor();

    await addPath(includedField(), "/app");

    expect(screen.getByText("/app")).toBeTruthy();
    // The input is cleared, so the next path does not append to the last one.
    expect((includedField() as HTMLInputElement).value).toBe("");
  });

  test("refuses a path that is not absolute", async () => {
    // Prefix matching is anchored at the origin root. A relative-looking path
    // would silently match nothing, so the API rejects it and so does this.
    renderEditor();

    await addPath(includedField(), "app");

    expect(screen.getByText(/Path must start with/)).toBeTruthy();
    expect(screen.queryByText("app")).toBeNull();
    // Left in the box on purpose: the user fixes what they typed rather than
    // retyping it from scratch.
    expect((includedField() as HTMLInputElement).value).toBe("app");
  });

  test("refuses a path longer than the column allows", async () => {
    renderEditor();

    await addPath(includedField(), `/${"x".repeat(600)}`);

    expect(screen.getByText(/exceeds maximum length/)).toBeTruthy();
  });

  test("ignores an empty submission", async () => {
    renderEditor();

    await addPath(includedField(), "   ");

    // Not an error either: the user pressed Enter on an empty box, which is
    // not a mistake worth a message.
    expect(screen.queryByText(/Path must start with/)).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  test("trims surrounding whitespace, as the API does", async () => {
    renderEditor();

    await addPath(includedField(), "  /api/v1  ");

    expect(screen.getByText("/api/v1")).toBeTruthy();
  });

  test("does not add the same path twice", async () => {
    renderEditor();

    await addPath(includedField(), "/app");
    await addPath(includedField(), "/app");

    expect(screen.getAllByText("/app")).toHaveLength(1);
  });

  test("clears an earlier complaint once a valid path is added", async () => {
    // A message left over from a mistake the user has already corrected reads
    // as a rejection of what they just typed.
    renderEditor();

    await addPath(includedField(), "app");
    expect(screen.getByText(/Path must start with/)).toBeTruthy();

    await addPath(includedField(), "/app");
    expect(screen.queryByText(/Path must start with/)).toBeNull();
  });

  test("keeps the two lists apart", async () => {
    renderEditor();

    await addPath(includedField(), "/app");
    await addPath(excludedField(), "/logout");

    await userEvent.setup().click(saveButton());

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      includedPaths: ["/app"],
      excludedPaths: ["/logout"],
    });
  });
});

describe("removing a path", () => {
  test("drops it from the list", async () => {
    renderEditor(target({ includedPaths: ["/app", "/api"] }));

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove /app" }));

    expect(screen.queryByText("/app")).toBeNull();
    expect(screen.getByText("/api")).toBeTruthy();
  });

  test("removes only the path asked for, from the right list", async () => {
    // Both lists can hold the same prefix, and removing from one must not
    // quietly widen the other.
    renderEditor(
      target({ includedPaths: ["/admin"], excludedPaths: ["/admin"] }),
    );

    const [first] = screen.getAllByRole("button", { name: "Remove /admin" });
    await userEvent.setup().click(first!);

    expect(screen.getAllByText("/admin")).toHaveLength(1);
  });
});

describe("saving", () => {
  test("stays disabled until something actually changes", async () => {
    renderEditor(target({ includedPaths: ["/app"] }));
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Scope is up to date")).toBeTruthy();

    await addPath(includedField(), "/api");

    expect(saveButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  test("sends the lists as they stand", async () => {
    renderEditor(target({ includedPaths: ["/old"] }));

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Remove /old" }));
    await addPath(includedField(), "/new");
    await userEvent.setup().click(saveButton());

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.includedPaths).toEqual(["/new"]);
  });

  test("says so when it worked", async () => {
    renderEditor();

    await addPath(includedField(), "/app");
    await userEvent.setup().click(saveButton());

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toEqual({
      kind: "success",
      message: "Scope updated successfully",
    });
  });

  test("reports what the API said when it refused", async () => {
    // The API is the control; a refusal here means the two rule sets disagree,
    // and swallowing it would leave the user believing the scope was saved.
    saveFails = true;
    renderEditor();

    await addPath(includedField(), "/app");
    await userEvent.setup().click(saveButton());

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toEqual({
      kind: "error",
      message: "Scope rejected by the API.",
    });
  });
});

describe("an archived target", () => {
  test("cannot have its scope edited", async () => {
    // Archiving is the operator's off switch. Leaving the editor live would
    // offer a change the API will refuse.
    renderEditor(target({ isArchived: true, includedPaths: ["/app"] }));

    expect((includedField() as HTMLInputElement).disabled).toBe(true);
    expect((excludedField() as HTMLInputElement).disabled).toBe(true);
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  test("offers no way to remove an existing path", async () => {
    renderEditor(target({ isArchived: true, includedPaths: ["/app"] }));

    expect(screen.queryByRole("button", { name: "Remove /app" })).toBeNull();
    // The path is still shown: the scope is a record of what was scanned.
    expect(screen.getByText("/app")).toBeTruthy();
  });
});

describe("an empty scope", () => {
  test("says what an empty included list means", async () => {
    // Empty means the whole origin, which is the opposite of what an empty
    // allowlist usually means. Leaving it blank invites the wrong guess.
    renderEditor();

    const card = screen.getByText("Included Path Prefixes").closest("div")!;
    expect(
      within(card.parentElement!).getByText(/all origin paths are in scope/),
    ).toBeTruthy();
  });
});
