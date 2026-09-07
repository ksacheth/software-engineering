import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@better-auth-ui/react';
import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';

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

function getReconnectDelay(attempt: number) {
  const cappedDelay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  return cappedDelay * (0.5 + Math.random());
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession(authClient);
  const [settledSession, setSettledSession] = useState<typeof session>();
  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const subscribersRef = useRef(new Set<WebSocketMessageHandler>());

  useEffect(() => {
    if (!isPending) {
      setSettledSession(session);
    }
  }, [isPending, session]);

  useEffect(() => {
    let isActive = true;

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
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;
        setStatus('connecting');

        ws.onopen = () => {
          if (!isActive) return;
          reconnectAttemptRef.current = 0;
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

          const scanMessage = message as { scanJobId?: string; type?: string };
          if (scanMessage.scanJobId && typeof message === 'object' && message !== null) {
            queryClient.setQueryData<Record<string, unknown>>(['scan', scanMessage.scanJobId], (old) => ({
              ...(old ?? {}),
              ...message,
            }));
            if (scanMessage.type === 'scan.completed') {
              void queryClient.invalidateQueries({ queryKey: ['findings', scanMessage.scanJobId] });
            }
          }
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
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.close();
      }
    };
  }, [settledSession?.user.id]);

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
