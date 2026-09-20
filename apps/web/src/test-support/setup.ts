import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

/**
 * A DOM for the dashboard's tests.
 *
 * Registered here rather than per file so every test file gets the same
 * environment, and torn down between tests: React Testing Library appends each
 * render to `document.body`, so without the cleanup a query can match a node
 * left behind by an earlier test and pass for the wrong reason.
 */
GlobalRegistrator.register({ url: "http://localhost:3000/" });

/**
 * React's act warnings, minus the ones nobody can act on.
 *
 * Radix opens a popover, a tooltip or a select in stages: a layout effect
 * positions it and a transition settles it, both after the click that opened it
 * has returned. React notices the state update landing outside `act` and warns,
 * once per update, which is a hundred and sixty lines of warning for a run that
 * passes. There is nothing to await, because the update is not the component's
 * response to anything a test did.
 *
 * So warnings naming a primitive from that library are dropped and everything
 * else is left alone. An update escaping `act` in our own components is a real
 * signal: it usually means a test asserts on a render that has not happened yet,
 * and it stays visible.
 */
/** Radix primitives, as React names them in the warning's arguments. */
const THIRD_PARTY_COMPONENT =
  /^(Popper|Presence|Tooltip|Select|Dismissable|Popover|Dialog|Collection|Portal|Focus|Slot)/;

const realConsoleError = console.error;
console.error = (format: unknown, ...values: unknown[]) => {
  // React passes the component name as an argument rather than interpolating
  // it, so the name is what gets matched, not the message.
  const isActWarning = String(format).includes("was not wrapped in act");
  const blamesThirdParty = values.some((value) =>
    THIRD_PARTY_COMPONENT.test(String(value).replace(/^ForwardRef\(/, "")),
  );
  if (isActWarning && blamesThirdParty) return;
  realConsoleError(format, ...values);
};

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
