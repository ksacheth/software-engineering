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
    // Check for comment-only line when not in dollar block
    const trimmed = line.trim();
    if (!inDollarBlock && trimmed.startsWith('--')) {
      continue;
    }

    // Toggle dollar block (e.g. DO $$ ... $$;)
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
  console.log('Running role bootstrap and grant synchronization...');
  const scriptPath = path.join(__dirname, 'bootstrap-roles.sql');
  const sqlContent = fs.readFileSync(scriptPath, 'utf8');

  const statements = splitSqlStatements(sqlContent);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log(`Executed ${statements.length} bootstrap statements successfully.`);
}

main()
  .catch((e) => {
    console.error('Error during role bootstrap:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
