import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailOTP, organization, twoFactor } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { prisma } from "@wvs/database";
import { EMAIL_VERIFICATION_CODE } from "@wvs/shared";
import { config } from "../config/env";
import { trustedProxyCidrs } from "../config/trusted-proxies";
import { sendEmail } from "./email";
import {
  deleteAccountEmail,
  resetPasswordEmail,
  verificationCodeEmail,
} from "./email-templates";

/**
 * F.1 confirmation codes (ADR-0013). Looked up by address because the OTP
 * plugin hands over only the email. Not awaited by the caller, for the same
 * timing reason as the reset email.
 */
async function sendVerificationCode(email: string, code: string): Promise<void> {
  // The name only personalises the greeting. A failed lookup must not stop the
  // code going out, or leave a rejection nothing handles.
  const user = await prisma.user
    .findUnique({ where: { email }, select: { name: true } })
    .catch(() => null);
  await sendEmail({
    to: email,
    ...verificationCodeEmail({ name: user?.name || email, code }),
  });
}

/**
 * The email OTP plugin also brings passwordless sign-in, OTP password reset and
 * OTP email change. WVS uses it for confirmation only: signing in with a code
 * would skip the password and the TOTP second factor, and resets stay on the
 * link flow above. Requesting a code goes through the standard
 * /send-verification-email route, which the plugin reroutes, so its own send
 * and check routes are closed too.
 */
const UNUSED_EMAIL_OTP_PATHS = [
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
  "/sign-in/email-otp",
  "/forget-password/email-otp",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
];

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
  // The confirmation itself is a code from the emailOTP plugin below, which
  // replaces the link. Signing in to an unconfirmed account sends a fresh
  // code, so a user who lost the first one is not stuck.
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
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
    // nginx (deploy/nginx) and the Vite dev proxy both forward the original
    // host and protocol in X-Forwarded-* headers.
    trustedProxyHeaders: true,
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      // Only the proxies TRUST_PROXY names are trusted, so a direct caller
      // cannot spoof X-Forwarded-For to evade the per-IP rate limit
      // (NFR-SEC-1, F.8). Loopback unless the deployment says otherwise.
      trustedProxies: trustedProxyCidrs(config.trustProxy),
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // F.8: a suspended account gets no session, whichever way it signs
          // in. Checked here rather than on the sign-in route because every
          // path that authenticates (password, two-factor, a future provider)
          // ends by creating a session.
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { suspendedAt: true },
          });
          if (user?.suspendedAt) {
            throw new APIError("FORBIDDEN", {
              message: "This account has been suspended by an administrator.",
              code: "ACCOUNT_SUSPENDED",
            });
          }

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
    emailOTP({
      overrideDefaultEmailVerification: true,
      otpLength: EMAIL_VERIFICATION_CODE.length,
      expiresIn: EMAIL_VERIFICATION_CODE.expiresInMinutes * 60,
      allowedAttempts: EMAIL_VERIFICATION_CODE.allowedAttempts,
      // A code is a credential: only its hash is stored, as with share links
      // (ADR-0011), so a read of the verification table yields nothing usable.
      storeOTP: "hashed",
      sendVerificationOTP: async ({ email, otp, type }) => {
        // Defence in depth: the routes for the other types are closed above.
        if (type !== "email-verification") return;
        void sendVerificationCode(email, otp);
      },
    }),
  ],
  disabledPaths: UNUSED_EMAIL_OTP_PATHS,
  rateLimit: {
    enabled: true,
  },
  trustedOrigins: process.env.WEB_ORIGIN?.split(",") ?? [
    "http://localhost:3000",
  ],
});
