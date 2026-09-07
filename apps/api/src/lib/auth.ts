import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, twoFactor } from 'better-auth/plugins';
import { prisma } from '@wvs/database';

export const auth = betterAuth({
  appName: 'Website Vulnerability Scanner',
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12, // SRS F.1: passwords of at least 12 characters
    maxPasswordLength: 256,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const orgName = `${user.name || user.email.split('@')[0]}'s Organization`;
          const baseSlug = (user.name || user.email.split('@')[0])
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-');
          const slug = `${baseSlug}-${user.id.slice(-6)}`;
          await auth.api.createOrganization({
            body: {
              name: orgName,
              slug,
              userId: user.id,
            },
          });
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: 'owner',
    }),
    twoFactor({
      issuer: 'Website Vulnerability Scanner',
    }),
  ],
  rateLimit: {
    enabled: true,
  },
  trustedOrigins: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3000'],
});
