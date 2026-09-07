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
          const identity = user.name || user.email.split('@')[0];
          const baseSlug = identity
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

          try {
            await prisma.$transaction(async (tx) => {
              const organization = await tx.organization.create({
                data: {
                  name: `${identity}'s Organization`,
                  slug: `${baseSlug || 'organization'}-${user.id}`,
                },
              });
              await tx.member.create({
                data: {
                  organizationId: organization.id,
                  userId: user.id,
                  role: 'owner',
                },
              });
            });
          } catch (error) {
            await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
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
