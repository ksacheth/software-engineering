import Redis from "ioredis";
import { isScanEvent, type ScanEvent } from "@wvs/shared";
import { redisConnectionOptions } from "../../config/env";

/**
 * F.3 event transport (ADR-0006).
 *
 * The orchestrator publishes every scan event to one Redis pub/sub channel;
 * every API instance subscribes and fans out to its own WebSocket clients.
 * This keeps the API stateless, since no instance holds scan state and any
 * instance can serve any client (NFR-SCAL-1).
 *
 * Because pub/sub is fan-out, nothing on this channel may have a side effect:
 * a completion email published here would send once per instance.
 */

export const SCAN_EVENTS_CHANNEL = "wvs:scan-events";

export type ScanEventHandler = (event: ScanEvent) => void;

let publisher: Redis | null = null;

/**
 * Publish events the API itself caused.
 *
 * The orchestrator publishes nearly everything on this channel, but a scan the
 * kill switch aborts may have no worker to announce it: a queued scan never had
 * one. Without this, a live view would sit on "queued" until it next polled.
 * Still side-effect free, per ADR-0006: every instance fans these out and does
 * nothing else.
 */
export async function publishScanEvents(events: ScanEvent[]): Promise<void> {
  if (events.length === 0) return;
  publisher ??= new Redis({
    ...redisConnectionOptions(),
    maxRetriesPerRequest: 2,
  });
  try {
    await Promise.all(
      events.map((event) =>
        publisher!.publish(SCAN_EVENTS_CHANNEL, JSON.stringify(event)),
      ),
    );
  } catch (error) {
    // The rows already say what happened and the live view polls as a
    // fallback, so a lost announcement costs latency, not correctness.
    console.error("[scan-events] publish failed", error);
  }
}

/** Shutdown and test teardown: lets the process exit. */
export async function closeScanEventPublisher(): Promise<void> {
  if (!publisher) return;
  const closing = publisher;
  publisher = null;
  try {
    await closing.quit();
  } catch {
    closing.disconnect();
  }
}

export interface ScanEventSubscription {
  close(): Promise<void>;
}

export function subscribeToScanEvents(
  handler: ScanEventHandler,
): ScanEventSubscription {
  const subscriber = new Redis({
    ...redisConnectionOptions(),
    maxRetriesPerRequest: 2,
  });

  subscriber.on("message", (_channel: string, payload: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // Not ours; a shared channel must tolerate foreign messages.
    }
    if (isScanEvent(parsed)) {
      handler(parsed);
    }
  });

  subscriber.on("error", (error) => {
    console.error("[scan-events] subscriber error", error.message);
  });

  void subscriber
    .subscribe(SCAN_EVENTS_CHANNEL)
    .catch((error) =>
      console.error("[scan-events] subscribe failed", error.message),
    );

  return {
    close: async () => {
      try {
        await subscriber.quit();
      } catch {
        subscriber.disconnect();
      }
    },
  };
}
