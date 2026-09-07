import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: '/api/auth',
  plugins: [twoFactorClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
