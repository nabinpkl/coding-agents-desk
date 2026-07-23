/**
 * Endpoints shared by the frontend and the FastAPI voice backend.
 *
 * REST goes through a same-origin path that Next rewrites to the backend
 * (see next.config.ts), so there is no cross-origin request and no CORS.
 * The WebSocket connects to the backend directly (WS is exempt from CORS and
 * is not proxied by Next dev rewrites). Override via NEXT_PUBLIC_* env.
 */

export const API_BASE: string = process.env.NEXT_PUBLIC_API_BASE ?? "/api";

export const VOICE_WS_URL: string =
  process.env.NEXT_PUBLIC_VOICE_WS_URL ?? "ws://127.0.0.1:8001/ws/voice";
