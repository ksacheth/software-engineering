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
          const orgIdentity = user.name || user.email.split('@')[0];
          const orgName = `${orgIdentity}'s Organization`;
          const baseSlug = orgIdentity
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
          const slug = `${baseSlug || 'organization'}-${user.id}`;

          try {
            await auth.api.createOrganization({
              body: {
                name: orgName,
                slug,
                userId: user.id,
              },
            });
          } catch (error) {
            await prisma.user.delete({ where: { id: user.id } });
            throw error;
          }
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
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
