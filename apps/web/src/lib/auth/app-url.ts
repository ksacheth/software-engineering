import { getViewURL } from "@better-auth-ui/core";

/**
 * Absolute URL for a path served by this app.
 *
 * Better Auth resolves `callbackURL` and `redirectTo` against the API base URL
 * and validates them against the trusted origins. A relative path would send
 * the browser to the API origin (`:4100` in development) instead of the
 * dashboard, and the provider's `baseURL` is empty because the client is
 * deliberately same-origin (see `lib/auth-client.ts`).
 *
 * The web app is a browser-only SPA, so the current origin is the correct
 * absolute base. Passing an already-absolute URL through is a no-op.
 */
export function absoluteAppUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/**
 * Absolute URL for a view owned by the auth library.
 *
 * Equivalent to the library's `getViewURL`, but anchored to this app's origin.
 * `getViewURL` alone returns a root-relative path when `baseURL` is empty, and
 * Better Auth then resolves it against the API origin.
 */
export function absoluteViewUrl(basePath: string, viewPath: string): string {
  return absoluteAppUrl(getViewURL("", basePath, viewPath));
}
