import { Prisma, prisma } from "@wvs/database";

/**
 * Run a transaction at SERIALIZABLE, retrying when Postgres aborts it for a
 * conflict.
 *
 * Used where a check and the write it guards must not interleave with another
 * request's: a quota count and the insert it permits, or the kill switch and a
 * scan being queued behind its back. Serialization failures are the expected
 * price of that guarantee, so a few retries are part of the contract rather
 * than an error path.
 */
const MAX_SERIALIZATION_RETRIES = 3;

function isSerializationFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

export async function serializable<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        isSerializationFailure(error) &&
        attempt < MAX_SERIALIZATION_RETRIES
      ) {
        continue;
      }
      throw error;
    }
  }
}
