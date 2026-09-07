import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization, twoFactor } from 'better-auth/plugins';
import { prisma } from '@wvs/database';

function wrapPrismaForAuth(client: any): any {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'account') {
        const origAccount = target.account;
        return new Proxy(origAccount, {
          get(accTarget, accProp, accReceiver) {
            if (accProp === 'create') {
              return async (args: any) => {
                const { issuer, ...cleanData } = args?.data || {};
                const res = await origAccount.create({ ...args, data: cleanData });
                return res ? { ...res, issuer: issuer ?? 'local:credential' } : res;
              };
            }
            if (accProp === 'findFirst' || accProp === 'findUnique') {
              return async (args: any) => {
                let cleanArgs = args;
                if (args?.where && 'issuer' in args.where) {
                  const { issuer, ...cleanWhere } = args.where;
                  cleanArgs = { ...args, where: cleanWhere };
                }
                const res = await origAccount[accProp](cleanArgs);
                return res ? { ...res, issuer: res.issuer ?? 'local:credential' } : res;
              };
            }
            if (accProp === 'findMany') {
              return async (args: any) => {
                let cleanArgs = args;
                if (args?.where && 'issuer' in args.where) {
                  const { issuer, ...cleanWhere } = args.where;
                  cleanArgs = { ...args, where: cleanWhere };
                }
                const res = await origAccount.findMany(cleanArgs);
                return Array.isArray(res)
                  ? res.map((r: any) => ({ ...r, issuer: r.issuer ?? 'local:credential' }))
                  : res;
              };
            }
            return Reflect.get(accTarget, accProp, accReceiver);
          },
        });
      }
      if (prop === 'user') {
        const origUser = target.user;
        return new Proxy(origUser, {
          get(userTarget, userProp, userReceiver) {
            if (userProp === 'findFirst' || userProp === 'findUnique') {
              return async (args: any) => {
                const res = await origUser[userProp](args);
                if (res?.accounts && Array.isArray(res.accounts)) {
                  res.accounts = res.accounts.map((acc: any) => ({
                    ...acc,
                    issuer: acc.issuer ?? 'local:credential',
                  }));
                }
                return res;
              };
            }
            return Reflect.get(userTarget, userProp, userReceiver);
          },
        });
      }
      if (prop === '$transaction') {
        return async (arg: any, options?: any) => {
          if (typeof arg === 'function') {
            return target.$transaction(async (tx: any) => {
              return arg(wrapPrismaForAuth(tx));
            }, options);
          }
          return target.$transaction(arg, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export const auth = betterAuth({
  appName: 'Website Vulnerability Scanner',
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(wrapPrismaForAuth(prisma), {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12, // SRS F.1: passwords of at least 12 characters
    maxPasswordLength: 256,
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const member = await prisma.member.findUnique({
            where: { userId: session.userId },
            select: { organizationId: true },
          });
          return { data: { ...session, activeOrganizationId: member?.organizationId ?? null } };
        },
      },
    },
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
