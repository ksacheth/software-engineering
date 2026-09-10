import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@better-auth-ui/react';
import { WS_PING_INTERVAL_MS, isScanSocketPing } from '@wvs/shared';
import { authClient } from '@/lib/auth-client';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WebSocketContextValue {
  status: WebSocketStatus;
  sendMessage: (data: unknown) => void;
  subscribe: (handler: WebSocketMessageHandler) => () => void;
}

export type WebSocketMessageHandler = (message: unknown) => void;

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * A socket that has gone quiet for this long is dead.
 *
 * A dropped connection does not always surface as a close: a proxy or a NAT
 * can swallow it, leaving a socket that reads as OPEN and never delivers
 * anything. The gateway's keepalive is what makes that visible, so two missed
 * pings is treated as a dead socket and the reconnect path runs (F.3, story 54).
 */
const PING_TIMEOUT_MS = WS_PING_INTERVAL_MS * 2 + 5_000;

function getReconnectDelay(attempt: number) {
  const cappedDelay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  return cappedDelay * (0.5 + Math.random());
}

/**
 * The gateway address (F.3).
 *
 * Production is same-origin, which is what the deployed reverse proxy serves.
 * Development connects to the API origin directly because the Vite dev proxy
 * drops WebSocket upgrades when Vite runs on Bun (see vite.config.ts); the API
 * accepts the dashboard origin for exactly this case.
 */
function resolveScanSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) {
    return `${protocol}//${window.location.hostname}:${__WVS_API_PORT__}/ws`;
  }
  return `${protocol}//${window.location.host}/ws`;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession(authClient);
  const [settledSession, setSettledSession] = useState<typeof session>();
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const subscribersRef = useRef(new Set<WebSocketMessageHandler>());
  const lastPingRef = useRef(0);

  useEffect(() => {
    if (!isPending) {
      setSettledSession(session);
    }
  }, [isPending, session]);

  useEffect(() => {
    let isActive = true;
    let pingWatchdog: ReturnType<typeof setInterval> | null = null;

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      reconnectAttemptRef.current += 1;
      if (reconnectAttemptRef.current > MAX_RECONNECT_ATTEMPTS) {
        setStatus('error');
        return;
      }

      setStatus('disconnected');
      reconnectTimeoutRef.current = setTimeout(connect, getReconnectDelay(reconnectAttemptRef.current));
    };

    function connect() {
      if (!isActive) return;
      try {
        const ws = new WebSocket(resolveScanSocketUrl());
        socketRef.current = ws;
        setStatus('connecting');

        ws.onopen = () => {
          if (!isActive) return;
          reconnectAttemptRef.current = 0;
          lastPingRef.current = Date.now();
          setStatus('connected');
        };

        ws.onmessage = (event) => {
          if (!isActive) return;
          let message: unknown;
          try {
            message = JSON.parse(event.data);
          } catch {
            subscribersRef.current.forEach((handler) => handler(event.data));
            return;
          }

          if (isScanSocketPing(message)) {
            lastPingRef.current = Date.now();
            return; // A keepalive is transport, not scan state.
          }

          // The provider carries transport, not scan semantics: it does not
          // merge messages into the query cache. A field-wise merge of
          // `scan.finding` would make a second finding overwrite the first,
          // so accumulation belongs to the consumer (see use-live-scan).
          subscribersRef.current.forEach((handler) => handler(message));
        };

        ws.onerror = () => {
          // The close handler schedules a bounded reconnect attempt.
        };

        ws.onclose = () => {
          if (!isActive) return;
          if (socketRef.current === ws) {
            socketRef.current = null;
          }
          scheduleReconnect();
        };

        // Watchdog for the half-open case above.
        pingWatchdog = setInterval(() => {
          if (!isActive) return;
          if (Date.now() - lastPingRef.current <= PING_TIMEOUT_MS) return;
          socketRef.current = null;
          ws.close();
        }, WS_PING_INTERVAL_MS);
      } catch {
        if (!isActive) return;
        scheduleReconnect();
      }
    }

    if (settledSession) {
      connect();
    } else {
      clearReconnectTimeout();
      reconnectAttemptRef.current = 0;
      setStatus('disconnected');
    }

    return () => {
      isActive = false;
      clearReconnectTimeout();
      if (pingWatchdog) clearInterval(pingWatchdog);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.close();
      }
    };
  }, [settledSession?.user?.id]);

  const sendMessage = useCallback((data: unknown) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback((handler: WebSocketMessageHandler) => {
    subscribersRef.current.add(handler);
    return () => subscribersRef.current.delete(handler);
  }, []);

  return (
    <WebSocketContext.Provider value={{ status, sendMessage, subscribe }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}
