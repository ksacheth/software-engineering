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
