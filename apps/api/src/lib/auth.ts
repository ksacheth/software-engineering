import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization, twoFactor } from "better-auth/plugins";
import { prisma } from "@wvs/database";
import { sendEmail } from "./email";
import {
  deleteAccountEmail,
  resetPasswordEmail,
  verificationEmail,
} from "./email-templates";

export const auth = betterAuth({
  appName: "Website Vulnerability Scanner",
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12, // SRS F.1: passwords of at least 12 characters
    maxPasswordLength: 256,
    // SRS F.1: "registration with email confirmation". No session is issued
    // until the user proves control of the address. This also makes sign-up
    // answer identically for an address that already exists, so it stops being
    // an account-enumeration oracle.
    requireEmailVerification: true,
    // A reset means the old credential is gone or compromised; every other
    // session minted from it must die too.
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 30, // 30 minutes
    sendResetPassword: async ({ user, url }) => {
      // Deliberately not awaited: an awaited send would leak account existence
      // through response timing (Better Auth docs, email-and-password).
      void sendEmail({
        to: user.email,
        ...resetPasswordEmail({ name: user.name, url }),
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    expiresIn: 60 * 60, // 1 hour
    sendVerificationEmail: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        ...verificationEmail({ name: user.name, url }),
      });
    },
  },
  user: {
    deleteUser: {
      enabled: true, // SRS F.1 (should): account deletion
      sendDeleteAccountVerification: async ({ user, url }) => {
        void sendEmail({
          to: user.email,
          ...deleteAccountEmail({ name: user.name, url }),
        });
      },
    },
  },
  advanced: {
    // nginx (deploy/nginx.conf) and the Vite dev proxy both forward the
    // original host and protocol in X-Forwarded-* headers.
    trustedProxyHeaders: true,
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      // Only the loopback proxies are trusted, so a direct caller cannot spoof
      // X-Forwarded-For to evade the per-IP rate limit (NFR-SEC-1, F.8).
      trustedProxies: ["127.0.0.1", "::1"],
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const member = await prisma.member.findUnique({
            where: { userId: session.userId },
            select: { organizationId: true },
          });
          return {
            data: {
              ...session,
              activeOrganizationId: member?.organizationId ?? null,
            },
          };
        },
      },
    },
    user: {
      create: {
        after: async (user) => {
          const identity = user.name || user.email.split("@")[0];
          const baseSlug = identity
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");

          try {
            await prisma.$transaction(async (tx) => {
              const organization = await tx.organization.create({
                data: {
                  name: `${identity}'s Organization`,
                  slug: `${baseSlug || "organization"}-${user.id}`,
                },
              });
              await tx.member.create({
                data: {
                  organizationId: organization.id,
                  userId: user.id,
                  role: "owner",
                },
              });
            });
          } catch (error) {
            await prisma.user
              .delete({ where: { id: user.id } })
              .catch(() => {});
            throw error;
          }
        },
      },
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      creatorRole: "owner",
    }),
    twoFactor({
      issuer: "Website Vulnerability Scanner",
    }),
  ],
  rateLimit: {
    enabled: true,
  },
  trustedOrigins: process.env.WEB_ORIGIN?.split(",") ?? [
    "http://localhost:3000",
  ],
});
