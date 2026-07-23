import type { NextConfig } from "next";

// The FastAPI voice backend. REST calls are proxied through Next (same-origin
// /api/*), so the browser never makes a cross-origin request and no CORS layer
// is needed. The WebSocket connects to the backend directly (WS is exempt from
// CORS). Override the backend location with VOICE_BACKEND_URL.
const BACKEND_URL = process.env.VOICE_BACKEND_URL ?? "http://127.0.0.1:8001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
