import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url,
    },
  },
});

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inDollarBlock = false;

  const lines = sql.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inDollarBlock && trimmed.startsWith('--')) {
      continue;
    }

    const dollarMatches = (line.match(/\$\$/g) || []).length;
    if (dollarMatches % 2 === 1) {
      inDollarBlock = !inDollarBlock;
    }

    current += line + '\n';

    if (!inDollarBlock && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      current = '';
    }
  }

  if (current.trim().length > 0) {
    statements.push(current.trim());
  }

  return statements;
}

async function main() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  let appPassword = process.env.WVS_APP_PASSWORD;

  if (!appPassword) {
    if (nodeEnv === 'production' || nodeEnv === 'staging') {
      throw new Error(
        'SECURITY ERROR: WVS_APP_PASSWORD environment variable must be set in production and staging environments.'
      );
    }
    appPassword = 'wvs_app_dev_password';
    console.warn(
      '⚠️  [SECURITY WARNING] WVS_APP_PASSWORD is not set. Using local development fallback password.'
    );
  }

  console.log('Running role bootstrap and grant synchronization...');
  const scriptPath = path.join(__dirname, 'bootstrap-roles.sql');
  const sqlContent = fs.readFileSync(scriptPath, 'utf8');

  const statements = splitSqlStatements(sqlContent);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }

  // Safely synchronize wvs_app password
  const escapedPassword = appPassword.replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`ALTER ROLE wvs_app WITH LOGIN PASSWORD '${escapedPassword}';`);

  console.log(`Executed ${statements.length} bootstrap statements and synchronized wvs_app credentials successfully.`);
}

main()
  .catch((e) => {
    console.error('Error during role bootstrap:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
