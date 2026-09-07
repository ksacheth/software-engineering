import { type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@better-auth-ui/react';
import { authClient } from '@/lib/auth-client';
import { Spinner } from '@/components/ui/spinner';

export interface RequireAuthProps {
  children?: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { data: session, isPending } = useSession(authClient);
  const location = useLocation();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }

  if (!session) {
    const fullPath = location.pathname + location.search;
    return <Navigate to={`/auth/sign-in?redirectTo=${encodeURIComponent(fullPath)}`} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
}
