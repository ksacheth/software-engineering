import { useCallback, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { authClient } from "@/lib/auth-client";
import { twoFactorPlugin } from "@/lib/auth/two-factor-plugin";
import { AuthProvider } from "@/components/auth/auth-provider";
import { RequireAuth } from "@/components/auth/require-auth";
import { WebSocketProvider } from "@/providers/websocket-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthPage } from "@/pages/auth/auth-page";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { TargetsPage } from "@/pages/targets/targets-page";
import { TargetDetailPage } from "@/pages/targets/target-detail-page";
import { TargetVerifyPage } from "@/pages/targets/target-verify-page";
import { DashboardPage } from "@/pages/dashboard/dashboard-page";
import { ScansPage } from "@/pages/scans/scans-page";
import { ScanDetailPage } from "@/pages/scans/scan-detail-page";
import { FindingsPage } from "@/pages/findings/findings-page";
import { ReportsPage } from "@/pages/reports/reports-page";
import { AdminPage } from "@/pages/admin/admin-page";
import { SettingsPage } from "@/pages/settings/settings-page";

function AuthProviderWrapper({ children }: { children: ReactNode }) {
  const routerNavigate = useNavigate();
  const location = useLocation();
  const navigate = useCallback(
    ({ to, replace }: { to: string; replace?: boolean }) => {
      routerNavigate(to, { replace });
    },
    [routerNavigate],
  );
  const requestedRedirect = new URLSearchParams(location.search).get(
    "redirectTo",
  );
  const redirectTo =
    requestedRedirect?.startsWith("/") && !requestedRedirect.startsWith("//")
      ? requestedRedirect
      : "/targets";

  return (
    <AuthProvider
      authClient={authClient}
      navigate={navigate}
      Link={({ href, ...props }) => <Link to={href} {...props} />}
      plugins={[twoFactorPlugin()]}
      queryClient={queryClient}
      redirectTo={redirectTo}
      emailAndPassword={{
        enabled: true,
        // Mirrors apps/api/src/lib/auth.ts. The client defaults (8/128) are
        // looser than the server rule (SRS F.1: at least 12), which would let
        // the browser accept a password the API then rejects.
        minPasswordLength: 12,
        maxPasswordLength: 256,
        // Must match the server flag, or sign-up navigates straight to the
        // dashboard while the API withholds the session.
        requireEmailVerification: true,
      }}
    >
      {children}
    </AuthProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProviderWrapper>
          <WebSocketProvider>
            <TooltipProvider>
              <Routes>
                {/* Auth routes */}
                <Route path="/auth/*" element={<AuthPage />} />

                {/* Protected dashboard routes */}
                <Route
                  element={
                    <RequireAuth>
                      <DashboardLayout />
                    </RequireAuth>
                  }
                >
                  <Route index element={<Navigate to="/targets" replace />} />
                  <Route path="/targets" element={<TargetsPage />} />
                  <Route path="/targets/:id" element={<TargetDetailPage />} />
                  <Route
                    path="/targets/:id/verify"
                    element={<TargetVerifyPage />}
                  />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/scans" element={<ScansPage />} />
                  <Route path="/scans/:id" element={<ScanDetailPage />} />
                  <Route path="/findings" element={<FindingsPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route path="/admin" element={<AdminPage />} />
                  <Route path="/settings/*" element={<SettingsPage />} />
                </Route>

                {/* Catch-all redirect to /targets */}
                <Route path="*" element={<Navigate to="/targets" replace />} />
              </Routes>
              <Toaster />
            </TooltipProvider>
          </WebSocketProvider>
        </AuthProviderWrapper>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
