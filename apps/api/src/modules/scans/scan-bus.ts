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

export interface ScanEventSubscription {
  close(): Promise<void>;
}

export function subscribeToScanEvents(
  handler: ScanEventHandler,
): ScanEventSubscription {
  const subscriber = new Redis({ ...redisConnectionOptions(), maxRetriesPerRequest: 2 });

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
