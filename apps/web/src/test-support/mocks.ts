import { mock } from "bun:test";

/**
 * The one place a module is replaced for tests.
 *
 * `mock.module` is global and is not undone between test files, so two files
 * each mocking part of the same module is a trap: whichever registers last
 * wins, and the other file's subject then imports a module missing the exports
 * it needs. That produced a hook under test quietly replaced by another file's
 * stub, and a `SyntaxError` for an export that exists.
 *
 * So every mocked module is registered exactly once, here, and every export is
 * kept. A test overrides the one function it cares about and the rest stay
 * real, which also means a file that wants the real module (the service tests)
 * is unaffected by a file that does not.
 *
 * Call `resetMocks()` in `beforeEach`.
 */

type Fn = (...args: never[]) => unknown;

/**
 * Wrap a module so named exports stay present and each function can be
 * redirected at run time.
 */
function overridable<T extends Record<string, unknown>>(real: T) {
  const overrides: Partial<Record<keyof T, Fn>> = {};

  const exports = { ...real } as Record<string, unknown>;
  for (const key of Object.keys(real)) {
    const value = real[key];
    if (typeof value !== "function") continue;
    // Classes pass through untouched. An arrow function is not constructible,
    // so wrapping one would break `new ScanApiError(...)` and, worse, the
    // `instanceof` checks the error handling branches on.
    if (/^class[\s{]/.test(Function.prototype.toString.call(value))) continue;
    exports[key] = (...args: never[]) => {
      const override = overrides[key as keyof T];
      return (override ?? (value as Fn))(...args);
    };
  }

  return {
    exports,
    set<K extends keyof T>(key: K, implementation: Fn) {
      overrides[key] = implementation;
    },
    clear() {
      for (const key of Object.keys(overrides)) {
        delete overrides[key as keyof T];
      }
    },
  };
}

const realScans = await import("@/services/scans");
const realTargets = await import("@/services/targets");
const realSocket = await import("@/providers/websocket-provider");
const realRole = await import("@/lib/use-role");
const realToast = await import("sonner");

const scansMock = overridable(realScans);
const targetsMock = overridable(realTargets);
const socketMock = overridable(realSocket);
const roleMock = overridable(realRole);
const toastMock = overridable(realToast.toast as unknown as Record<string, unknown>);

mock.module("@/services/scans", () => scansMock.exports);
mock.module("@/services/targets", () => targetsMock.exports);
mock.module("@/providers/websocket-provider", () => socketMock.exports);
mock.module("@/lib/use-role", () => roleMock.exports);
mock.module("sonner", () => ({ ...realToast, toast: toastMock.exports }));

/** Redirect one export of a module, for the duration of a test. */
export const stub = {
  scans: (key: keyof typeof realScans, implementation: Fn) =>
    scansMock.set(key, implementation),
  targets: (key: keyof typeof realTargets, implementation: Fn) =>
    targetsMock.set(key, implementation),
  socket: (key: keyof typeof realSocket, implementation: Fn) =>
    socketMock.set(key, implementation),
  role: (key: keyof typeof realRole, implementation: Fn) =>
    roleMock.set(key, implementation),
};

/** Toasts raised during a test, newest last. */
export const toasts: { kind: string; message: string }[] = [];

export function resetMocks(): void {
  scansMock.clear();
  targetsMock.clear();
  socketMock.clear();
  roleMock.clear();
  toastMock.clear();
  toasts.length = 0;

  for (const kind of ["success", "error", "info", "warning", "message"]) {
    toastMock.set(kind, ((message: string) => {
      toasts.push({ kind, message });
      return kind;
    }) as Fn);
  }
}

resetMocks();

/** The real error classes, so `instanceof` in the code under test still holds. */
export const { ScanApiError } = realScans;
export const { TargetApiError } = realTargets;
