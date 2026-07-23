/**
 * Entry for the embedded InteractionPanel bundle (Vite). Mounts the same
 * gesture and voice surfaces the Next app uses, so the interaction UI/logic is
 * authored once and shipped both ways. This bundle is copied into agent-desk's
 * InteractionPanel resources and served under the `interactionfeed://` scheme.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { InteractionApp } from "@/embed/interaction-app";
import { setLandmarkerAssetsMode } from "@/features/gesture/landmarker";

import "@/app/globals.css";

// The bundle ships its own MediaPipe assets; never reach for the CDN, even when
// previewed in a plain browser where isEmbedded() is false.
setLandmarkerAssetsMode("local");

const container = document.getElementById("root");
if (container === null) {
  throw new Error("embed root element #root missing");
}

createRoot(container).render(
  <StrictMode>
    <InteractionApp />
  </StrictMode>,
);
