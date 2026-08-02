import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/app/globals.css";
import { DictationMini } from "@/features/voice/components/dictation-mini";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DictationMini />
  </StrictMode>,
);
