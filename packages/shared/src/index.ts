/**
 * @wvs/shared: cross-app contracts.
 *
 * The F.1 email confirmation code, the F.3 scan contract (profiles, lifecycle rules, queue payload and
 * WebSocket event shapes), the F.6 findings enums, the F.7 report enums and
 * queue name, and the F.8 kill switch setting. Pure TypeScript, no build step, no database dependency, mirroring
 * `@wvs/scope-rules`. Prisma enums are duplicated here rather than imported
 * (ADR-0005 spirit); a compile-time assertion in the API guards against the
 * duplication drifting.
 */
export * from "./auth/index.js";
export * from "./scans/index.js";
export * from "./findings/index.js";
export * from "./reports/index.js";
export * from "./safety/index.js";
