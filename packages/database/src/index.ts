import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __wvs_prisma__: PrismaClient | undefined;
}

export const prisma =
  globalThis.__wvs_prisma__ ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__wvs_prisma__ = prisma;
}

export * from '@prisma/client';
