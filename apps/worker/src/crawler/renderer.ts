import type { DispatchRequest, DispatchResult } from "../scope-guard/dispatch.js";
import type { ExtractedForm } from "./extract.js";

/** The crawler's paced, guarded request; null when it never reached the target. */
export type GuardedFetch = (
  url: string,
  method: DispatchRequest["method"],
  headers: Record<string, string>,
) => Promise<DispatchResult | null>;

export interface RenderedPage {
  /** False when the document itself never loaded, so the other fields describe a blank page. */
  loaded: boolean;
  /** Same-origin links in the DOM after scripts ran. */
  links: string[];
  forms: ExtractedForm[];
  /** Same-origin XHR/fetch URLs the page requested while loading. */
  requestedUrls: string[];
}

/**
 * Renders a page with JavaScript. Implementations must send every network
 * request through `fetch` and nothing else, so the browser cannot reach a
 * host the scope guard has not approved.
 */
export interface PageRenderer {
  render(url: string, fetch: GuardedFetch): Promise<RenderedPage>;
  close(): Promise<void>;
}
