// What this surface can actually receive, detected rather than assumed.
//
// The panel runs in two WKWebViews, one on macOS and one on iPhone, and WebKit
// release notes describe Safari rather than WKWebView. Every plan for putting
// live window video in front of the viewer forks on whether these exist here, so
// the panel reports them instead of anyone reading a blog post and hoping.
//
// What each one buys, in the shape we care about (JavaScript appends bytes and
// never touches a pixel):
//
//   managedMediaSource  the iOS-appropriate MSE, power-managed, Safari 17+
//   mediaSource         plain MSE, the macOS path
//   hevcFragmented      whether either of those will accept fragmented HEVC,
//                       which is what VideoToolbox already produces
//   webTransport        QUIC pipe for the bytes, new in Safari 26.4. Optional:
//                       a WebSocket carries the same fragments more slowly.
//   videoDecoder        WebCodecs. Present is not the same as wanted: it hands
//                       back frames the page must draw, which is the path this
//                       design avoids.

/** The subset of `globalThis` this probe reads. Injected so it is testable. */
export interface MediaScope {
  WebTransport?: unknown;
  ManagedMediaSource?: { isTypeSupported?: (type: string) => boolean };
  MediaSource?: { isTypeSupported?: (type: string) => boolean };
  VideoDecoder?: unknown;
}

export interface MediaCapabilities {
  webTransport: boolean;
  managedMediaSource: boolean;
  mediaSource: boolean;
  videoDecoder: boolean;
  /** Fragmented HEVC accepted by whichever MSE flavour exists. */
  hevcFragmented: boolean;
}

/**
 * Main profile, level 3.1, which is what VideoToolbox emits for screen content
 * at the sizes a tile grid uses. A narrow probe on purpose: "some HEVC" is not
 * an answer, the question is whether the stream we already produce would play.
 */
export const HEVC_FRAGMENT_TYPE = 'video/mp4; codecs="hvc1.1.6.L93.B0"';

export function detectMediaCapabilities(scope: MediaScope = globalThis): MediaCapabilities {
  const managed = typeof scope.ManagedMediaSource !== "undefined";
  const plain = typeof scope.MediaSource !== "undefined";
  const source = scope.ManagedMediaSource ?? scope.MediaSource;
  let hevc = false;
  try {
    hevc = source?.isTypeSupported?.(HEVC_FRAGMENT_TYPE) === true;
  } catch {
    // A throwing isTypeSupported is a no, not a crash. This line runs on every
    // panel open, including on whatever WebKit ships next.
    hevc = false;
  }
  return {
    webTransport: typeof scope.WebTransport !== "undefined",
    managedMediaSource: managed,
    mediaSource: plain,
    videoDecoder: typeof scope.VideoDecoder !== "undefined",
    hevcFragmented: hevc,
  };
}

/**
 * Whether this surface could take hardware-decoded HEVC with the page only ever
 * appending bytes. WebTransport is deliberately not required: it is the faster
 * pipe, not the capability.
 */
export function canReceiveFragmentedVideo(caps: MediaCapabilities): boolean {
  return (caps.managedMediaSource || caps.mediaSource) && caps.hevcFragmented;
}

/** Terse enough for a menu footer, complete enough to act on. */
export function summarizeMediaCapabilities(caps: MediaCapabilities): string {
  const flag = (name: string, on: boolean) => `${name} ${on ? "yes" : "no"}`;
  return [
    flag("MMS", caps.managedMediaSource),
    flag("MSE", caps.mediaSource),
    flag("hevc", caps.hevcFragmented),
    flag("WT", caps.webTransport),
    flag("WC", caps.videoDecoder),
  ].join(" · ");
}
