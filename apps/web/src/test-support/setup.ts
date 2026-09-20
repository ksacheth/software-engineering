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

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
