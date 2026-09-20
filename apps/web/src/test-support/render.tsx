import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The providers a page needs, as `App.tsx` supplies them.
 *
 * A page mounted without them does not merely lose styling: Radix throws for a
 * tooltip outside its provider, and the badge that explains why a target is not
 * scannable is a tooltip. Composing them here keeps a page test failing for
 * reasons about the page.
 *
 * Retries are off. The default query client retries a failed request three
 * times with a growing delay, so a test about an error state would wait on
 * backoff before the error ever reached the screen.
 */

/** Renders the current path, so navigation can be asserted. */
export function CurrentPath() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

export interface RenderPageOptions {
  /** The route pattern the element is mounted at, for `useParams`. */
  path?: string;
  /** The entry to start at. Defaults to `path` with no parameters. */
  route?: string;
}

export function renderPage(
  ui: ReactElement,
  { path = "*", route = "/" }: RenderPageOptions = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={<>{children}</>} />
          </Routes>
          <CurrentPath />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );

  return { queryClient, ...render(ui, { wrapper }) };
}

/** The path the router is currently on. */
export function currentPath(): string {
  return document.querySelector('[data-testid="path"]')?.textContent ?? "";
}
