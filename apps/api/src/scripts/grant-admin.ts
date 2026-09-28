/**
 * Create an administrator from the deployment host (F.8, ADR-0009).
 *
 * The ADMIN role is never granted at signup, so the first administrator is
 * made here, by someone with shell access to the deployment. Later ones are
 * granted in the admin UI.
 *
 *   bun run --filter @wvs/api admin:grant someone@example.com
 *
 * The account must already exist and have confirmed its email address. The
 * grant is written to the audit log with no acting user and `source: "cli"`.
 */
import { prisma } from "@wvs/database";
import { grantAdminFromHost } from "../modules/admin/users";

const EXPLANATION = {
  NOT_FOUND: "No account uses that address. Sign up first, then run this again.",
  EMAIL_NOT_VERIFIED:
    "That account has not confirmed its email address, so it may not belong to who you think. Confirm it first.",
  SUSPENDED: "That account is suspended. Lift the suspension first.",
  ALREADY_ADMIN: "That account is already an administrator. Nothing changed.",
} as const;

async function main(): Promise<number> {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: bun run admin:grant <email>");
    return 2;
  }

  const result = await grantAdminFromHost(email);
  if (!result.ok) {
    console.error(`[admin:grant] ${EXPLANATION[result.reason]}`);
    return result.reason === "ALREADY_ADMIN" ? 0 : 1;
  }

  console.log(
    `[admin:grant] ${email} is now an administrator. They must enable two-factor authentication before using the admin area.`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[admin:grant] failed", error);
    await prisma.$disconnect();
    process.exit(1);
  });
