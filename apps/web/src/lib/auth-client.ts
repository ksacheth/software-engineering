import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

// baseURL is omitted intentionally: Better Auth defaults to the current origin
// with basePath /api/auth, which is exactly what we want behind the nginx
// (production) and Vite (dev) same-origin proxies. Setting an absolute URL here
// would make the session cookie cross-site and force SameSite=None.
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
