import { useCallback, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { authClient } from '@/lib/auth-client';
import { twoFactorPlugin } from '@/lib/auth/two-factor-plugin';
import { AuthProvider } from '@/components/auth/auth-provider';
import { RequireAuth } from '@/components/auth/require-auth';
import { WebSocketProvider } from '@/providers/websocket-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthPage } from '@/pages/auth/auth-page';
import { DashboardLayout } from '@/components/layout/dashboard-layout';
import { TargetsPage } from '@/pages/targets/targets-page';
import { DashboardPage } from '@/pages/dashboard/dashboard-page';
import { ScansPage } from '@/pages/scans/scans-page';
import { FindingsPage } from '@/pages/findings/findings-page';
import { ReportsPage } from '@/pages/reports/reports-page';
import { AdminPage } from '@/pages/admin/admin-page';
import { SettingsPage } from '@/pages/settings/settings-page';

function AuthProviderWrapper({ children }: { children: ReactNode }) {
  const routerNavigate = useNavigate();
  const navigate = useCallback(
    ({ to, replace }: { to: string; replace?: boolean }) => {
      routerNavigate(to, { replace });
    },
    [routerNavigate],
  );

  return (
    <AuthProvider
      authClient={authClient}
      navigate={navigate}
      Link={({ href, ...props }) => <Link to={href} {...props} />}
      plugins={[twoFactorPlugin()]}
      queryClient={queryClient}
      redirectTo="/targets"
    >
      {children}
    </AuthProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WebSocketProvider>
        <BrowserRouter>
          <AuthProviderWrapper>
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
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/scans" element={<ScansPage />} />
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
          </AuthProviderWrapper>
        </BrowserRouter>
      </WebSocketProvider>
    </QueryClientProvider>
  );
}
