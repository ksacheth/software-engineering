import { createAuthClient } from 'better-auth/react';
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins';

// baseURL is omitted intentionally: Better Auth defaults to the current origin
// with basePath /api/auth, which is exactly what we want behind the nginx
// (production) and Vite (dev) same-origin proxies. Setting an absolute URL here
// would make the session cookie cross-site and force SameSite=None.
export const authClient = createAuthClient({
  // emailOTPClient: F.1 email confirmation by code (ADR-0013).
  plugins: [twoFactorClient(), emailOTPClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
