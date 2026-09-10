import { useQuery } from '@tanstack/react-query';
import { useSession } from '@better-auth-ui/react';
import { authClient } from '@/lib/auth-client';

/**
 * F.1 roles, as resolved by the API.
 *
 * The role is a domain column Better Auth does not model, so it is not in the
 * library's session response. Asking the API for the same answer it uses for
 * authorisation keeps one source of truth, and any value that is not a known
 * write role is treated as read-only. Hiding a control is a courtesy; the API
 * is what enforces it.
 */
export type Role = 'ADMIN' | 'ANALYST' | 'DEVELOPER' | 'VIEWER';

const WRITE_ROLES: Role[] = ['ADMIN', 'ANALYST', 'DEVELOPER'];

export interface Me {
  id: string;
  organizationId: string;
  role: Role;
}

async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Identity lookup failed with status ${res.status}`);
  const data = (await res.json()) as { user: Me };
  return data.user;
}

export function useRole(): Role | null {
  const { data: session, isPending } = useSession(authClient);
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    enabled: !isPending && Boolean(session),
    staleTime: Infinity,
  });
  return data?.role ?? null;
}

export function useCanWrite(): boolean {
  const role = useRole();
  return role !== null && WRITE_ROLES.includes(role);
}
