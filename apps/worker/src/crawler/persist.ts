import type { Prisma, PrismaClient } from "@wvs/database";

export type CrawledPageClient = Pick<PrismaClient, "crawledPage">;

/**
 * Writes one page of the inventory. Keyed on (scan, normalized URL, method),
 * so a resumed scan that revisits a page updates it instead of failing.
 */
export async function persistCrawledPage(
  db: CrawledPageClient,
  page: Omit<Prisma.CrawledPageUncheckedCreateInput, "id" | "createdAt">,
): Promise<void> {
  const method = page.method ?? "GET";
  await db.crawledPage.upsert({
    where: {
      scanJobId_normalizedUrl_method: {
        scanJobId: page.scanJobId,
        normalizedUrl: page.normalizedUrl,
        method,
      },
    },
    create: { ...page, method },
    update: page,
  });
}
