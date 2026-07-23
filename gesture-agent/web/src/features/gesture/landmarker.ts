import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
} from "@mediapipe/tasks-vision";

import { isEmbedded } from "@/lib/host-bridge";

/**
 * The bundled `@mediapipe/tasks-vision` version. In the browser the Wasm loader
 * and models are pulled from the CDN at this exact version. Embedded in the
 * native panel there is no network, so the same assets are vendored into the
 * bundle and served at origin-root paths (the custom scheme + Vite publicDir
 * both resolve "/mediapipe" and "/models/..." to the bundled copies).
 */
const TASKS_VISION_VERSION = "0.10.35";

const CDN_WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const CDN_HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const CDN_FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const LOCAL_WASM_BASE_URL = "/mediapipe";
const LOCAL_HAND_MODEL_URL = "/models/hand_landmarker.task";
const LOCAL_FACE_MODEL_URL = "/models/face_landmarker.task";

interface LandmarkerAssets {
  wasmBaseUrl: string;
  handModelUrl: string;
  faceModelUrl: string;
}

type AssetsMode = "auto" | "local" | "cdn";

// "auto" resolves by isEmbedded() at load time. The Vite embed entry forces
// "local" so the offline bundle never reaches for the CDN even when previewed
// in a plain browser (where isEmbedded() is false).
let assetsMode: AssetsMode = "auto";

export function setLandmarkerAssetsMode(mode: AssetsMode): void {
  assetsMode = mode;
}

function landmarkerAssets(): LandmarkerAssets {
  const useLocal =
    assetsMode === "local" || (assetsMode === "auto" && isEmbedded());
  if (useLocal) {
    return {
      wasmBaseUrl: LOCAL_WASM_BASE_URL,
      handModelUrl: LOCAL_HAND_MODEL_URL,
      faceModelUrl: LOCAL_FACE_MODEL_URL,
    };
  }
  return {
    wasmBaseUrl: CDN_WASM_BASE_URL,
    handModelUrl: CDN_HAND_MODEL_URL,
    faceModelUrl: CDN_FACE_MODEL_URL,
  };
}

export interface GestureLandmarkers {
  hand: HandLandmarker;
  face: FaceLandmarker;
}

let loadPromise: Promise<GestureLandmarkers> | null = null;

async function createLandmarkers(): Promise<GestureLandmarkers> {
  const assets = landmarkerAssets();
  const fileset = await FilesetResolver.forVisionTasks(assets.wasmBaseUrl);

  const [hand, face] = await Promise.all([
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assets.handModelUrl, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    }),
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assets.faceModelUrl, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
    }),
  ]);

  return { hand, face };
}

/**
 * Loads (and memoizes) the hand and face landmarkers. The first call fetches
 * the Wasm runtime and both `.task` models; later calls reuse the same
 * instances. A failed load clears the cache so a retry can re-attempt.
 */
export function loadGestureLandmarkers(): Promise<GestureLandmarkers> {
  if (loadPromise === null) {
    loadPromise = createLandmarkers().catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}
