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
 * Only the exact names that have been seen to fire are dropped, rather than a
 * prefix: `components/ui` wraps every one of these primitives under a name of
 * its own, so matching on `Select` or `Dialog` would silence a wrapper we do
 * own the moment one of them grows state. Those wrappers are plain functions,
 * while the primitives below are forwarded refs, which is why two of these
 * names carry the wrapper React prints and would not match ours.
 *
 * An update escaping `act` anywhere else is a real signal, usually a test
 * asserting on a render that has not happened yet, and it stays visible. A new
 * name from the library shows up too, and gets added here deliberately or not
 * at all.
 */
const SETTLED_OUTSIDE_ACT = new Set([
  "Popper",
  "Presence",
  // Ours is a props pass-through with no state of its own, so an update
  // attributed to this name came from the primitive underneath it.
  "Tooltip",
  "SelectProvider",
  "ForwardRef(SelectItem)",
  "ForwardRef(SelectItemText)",
]);

const realConsoleError = console.error;
console.error = (format: unknown, ...values: unknown[]) => {
  // React passes the component name as an argument rather than interpolating
  // it, so the name is what gets matched, not the message.
  const isActWarning = String(format).includes("was not wrapped in act");
  const isSettled = values.some((value) =>
    SETTLED_OUTSIDE_ACT.has(String(value)),
  );
  if (isActWarning && isSettled) return;
  realConsoleError(format, ...values);
};

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
