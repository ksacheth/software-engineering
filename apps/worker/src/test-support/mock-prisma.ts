import type { PrismaClient } from "@wvs/database";

/**
 * In-memory stand-in for the parts of Prisma the orchestrator uses.
 *
 * `$transaction` snapshots every table and restores it if the callback throws,
 * so tests can check that a failed persist leaves nothing behind.
 */
export class MockPrisma {
  scanJobs = new Map<string, any>();
  crawledPages = new Map<string, any>();
  findings = new Map<string, any>();
  scanFindingDiffs: any[] = [];

  /** Called on every `scanJob.updateMany`, before it applies; lets a test change the row mid-scan. */
  onScanJobUpdate?: (where: any, data: any) => void;
  /** Makes `scanFindingDiff.createMany` throw, to exercise the rollback path. */
  failDiffInsert = false;
  /** The kill-switch setting row's value; undefined means no row, an Error means the read fails. */
  killSwitch: string | Error | undefined;

  systemSetting = {
    findUnique: async () => {
      if (this.killSwitch instanceof Error) throw this.killSwitch;
      return this.killSwitch === undefined ? null : { value: this.killSwitch };
    },
  };

  scanJob = {
    findUnique: async ({ where }: any) => this.scanJobs.get(where.id) || null,
    findFirst: async ({ where }: any) =>
      Array.from(this.scanJobs.values()).find(
        (j) =>
          j.targetId === where.targetId &&
          j.status === where.status &&
          (!where.id || j.id !== where.id.not)
      ) || null,
    updateMany: async ({ where, data }: any) => {
      this.onScanJobUpdate?.(where, data);
      const existing = this.scanJobs.get(where.id);
      if (!existing || !matches(existing, where)) return { count: 0 };
      this.scanJobs.set(where.id, { ...existing, ...data });
      return { count: 1 };
    },
  };

  crawledPage = {
    findMany: async ({ where }: any) =>
      Array.from(this.crawledPages.values()).filter((p) => p.scanJobId === where.scanJobId),
  };

  finding = {
    findMany: async ({ where }: any) =>
      Array.from(this.findings.values()).filter((f) => f.scanJobId === where.scanJobId),
    create: async ({ data }: any) => {
      const id = `finding-${this.findings.size + 1}`;
      const finding = { id, ...data };
      this.findings.set(id, finding);
      return finding;
    },
  };

  scanFindingDiff = {
    createMany: async ({ data }: any) => {
      if (this.failDiffInsert) throw new Error("diff insert failed");
      this.scanFindingDiffs.push(...data);
      return { count: data.length };
    },
  };

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const snapshot = {
      scanJobs: new Map(this.scanJobs),
      findings: new Map(this.findings),
      scanFindingDiffs: [...this.scanFindingDiffs],
    };
    try {
      return await fn(this);
    } catch (err) {
      Object.assign(this, snapshot);
      throw err;
    }
  }

  seedPage(scanJobId: string, url: string, responseHeaders: Record<string, string> = {}) {
    this.crawledPages.set(`page-${this.crawledPages.size + 1}`, {
      scanJobId,
      url,
      method: "GET",
      statusCode: 200,
      contentType: "text/html",
      requestHeaders: null,
      responseHeaders,
    });
  }

  asClient(): PrismaClient {
    return this as unknown as PrismaClient;
  }
}

function matches(row: any, where: any): boolean {
  if (where.attempt !== undefined && row.attempt !== where.attempt) return false;
  if (typeof where.status === "string") return row.status === where.status;
  if (where.status?.in) return where.status.in.includes(row.status);
  return true;
}

export class MockRedisPublisher {
  events: any[] = [];
  async publish(_channel: string, message: string) {
    this.events.push(JSON.parse(message));
  }
}
