/// <reference types="vite/client" />

/**
 * The API port, injected by vite.config.ts from the root .env.
 *
 * The dev dashboard opens its WebSocket directly against the API rather than
 * through the dev-server proxy, because Vite's proxy silently drops WebSocket
 * upgrades when Vite runs on Bun (it works under Node). See the comment in
 * vite.config.ts.
 */
declare const __WVS_API_PORT__: string;
