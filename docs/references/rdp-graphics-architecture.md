# Reference: RDP graphics architecture and its macOS analogues

Durable reference, not project analysis. Captures how Microsoft RDP remotes graphics and scroll, so future alignment work does not re-research from scratch. For how agent-desk currently diverges from this and what to fix, see `../rdp-alignment-readiness-review.md`. This file is the upstream source of truth those reviews cite.

Scope: the parts of RDP that matter for a capture-based, retained-surface remoter (surface/copy model, caching, per-region codecs, frame markers, backpressure), each mapped to the macOS-native signal that does or does not exist.

## How to read this

Each principle carries: what problem it solves, the RDP wire primitive, at least one dated citation, and the macOS equivalent (present, absent, or build-your-own). Citations are load-bearing. Do not strip them when this document is summarized or copied. Dates are the page `updated_at` from Microsoft Learn metadata (documentation-update timestamps, not original protocol publication), or "no date verifiable" where the source exposed none.

The protocol families referenced:
- **MS-RDPEGFX** Graphics Pipeline Extension. The modern surface/cache/codec command set. Published Version 19.0.
- **MS-RDPEGDI** GDI drawing orders. The legacy order stream (`ScrBlt`, `MemBlt`, offscreen cache).
- **MS-RDPRFX** RemoteFX codec (tile-based DWT).
- **MS-RDPBCGR** base connection, persistent bitmap/glyph cache capability sets.

## The one thing to remember

RDP never brute-force pixel-diffs captured frames to discover that a scroll happened. The windowing system or capture stack hands it a move vector ("this rectangle moved by dy"), and RDP issues a copy order. The pixels for a scroll never travel; the client re-blits its own already-decoded surface. Efficiency comes from (a) retained client surfaces, (b) copy orders sourced from OS damage, (c) caching repeated content, and (d) per-region codec selection. Not from one monolithic full-frame video codec.

---

## Part 1: The surface and copy model

### P1. Retained surfaces, not a single framebuffer

The client holds addressable on-screen and offscreen surfaces that operations mutate in place. This is the prerequisite for every no-pixel trick: if the client retains pixel state in named surfaces, the server sends only the delta operation.

- MS-RDPEGFX surface management: `RDPGFX_CREATE_SURFACE_PDU`, `RDPGFX_DELETE_SURFACE_PDU`, `RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU`, `RDPGFX_RESET_GRAPHICS_PDU` manage offscreen surface lifetime and map an offscreen surface to the visible output. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/5229ee1e-1cb4-4178-9739-a36f1258b685 (2025-08-11)
- MS-RDPEGFX landing, Published Version 19.0. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/da5c75f9-cd99-450c-98c4-014a496942b0 (2026-05-08)

**macOS:** Your own design. A retained client surface to blit into is a Core Animation / IOSurface / Metal choice. There is no standard on-the-wire surface model; you invent the command set.

### P2. On-screen-to-on-screen copy is the core no-pixel primitive

Move or scroll a region by copying pixels the client already holds. Wire cost is a few coordinates regardless of region size. Highest-leverage win for scroll-heavy content.

- MS-RDPEGFX `RDPGFX_SURFACE_TO_SURFACE_PDU` (cmdId `SURFACETOSURFACE` 0x0005) copies a rectangle between surfaces or within one surface, carrying `surfaceIdSrc`, `surfaceIdDest`, a single `rectSrc`, and an array of `destPts`. "Copy ... to a destination surface or to replicate bitmap data within the same surface." https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/0b19d058-fff0-43e5-8671-8c4186d60529 (2025-08-11)
- Legacy proof of the same idea: MS-RDPEGDI `ScrBlt` (`SCRBLT_ORDER`, order type 0x02) is a bit-block transfer from a source region to a destination region, source always the primary drawing surface. Fields `nLeftRect`/`nTopRect`/`nWidth`/`nHeight` (dest rect), `bRop`, `nXSrc`/`nYSrc` (source origin). A vertical scroll of `dy` is exactly `nYSrc = nTopRect - dy`. Max ~13 encoded bytes, no pixels. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/a4e322b0-cd64-4dfc-8e1a-f24dc0edc99d (2024-04-23)
- Order-type table listing `TS_ENC_SCRBLT_ORDER` 0x02 alongside `DstBlt`/`PatBlt`/`MemBlt`. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/23f766d4-8343-4e6b-8281-071ddccc0272 (2024-04-23)

**macOS:** No protocol analog and no GDI order stream. The conceptual equivalent is a blit on a retained CALayer / IOSurface / Metal texture, entirely client-side logic. This is the RFB/VNC `CopyRect` model (RFC 6143, 2011-03, https://www.rfc-editor.org/rfc/rfc6143.html), where window-move and scroll are the canonical copy case.

### P3. The move vector originates in the windowing system, never from pixel-diffing

Detecting a scroll by comparing two captured frames is expensive and ambiguous; you cannot reliably recover the motion vector from pixels alone. The component that performed the move already knows the vector.

- Legacy: GDI issues the `BitBlt`/`ScrollWindowEx`; the RDP mirror driver intercepts the operation and forwards it as a `ScrBlt` order. The driver sees a blit, not two frames. https://learn.microsoft.com/en-us/troubleshoot/windows-hardware/drivers/loading-starting-graphics-mirror-driver (no date verifiable)
- Modern: the DWM/DXGI **Desktop Duplication API** supplies OS metadata per frame. `IDXGIOutputDuplication::GetFrameMoveRects` returns `DXGI_OUTDUPL_MOVE_RECT` entries, "rectangles of pixels ... that the operating system moved," each with a source point and destination rect. `GetFrameDirtyRects` returns the non-overlapping updated rectangles. Documented rule: process all move rects before dirty rects. That is the encoder pipeline: emit copies for moves, then encode the residual dirty regions. https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-getframemoverects (2024-02-22) and https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-getframedirtyrects (Windows 8 / Server 2012 minimum)

**macOS: this is the decisive gap.** See Part 4. The OS used to provide the move vector and no longer does through the supported API.

### P4. Frame markers make a multi-order update atomic

A scroll is usually a move plus a small re-encode of newly exposed content. Rendering those piecemeal tears. The client must apply them as one frame.

- MS-RDPEGFX `RDPGFX_START_FRAME_PDU` (`STARTFRAME` 0x000B) / `RDPGFX_END_FRAME_PDU` (`ENDFRAME` 0x000C) bracket a batch; the client renders everything between them as one logical unit and replies `FRAMEACKNOWLEDGE` (0x000D). https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/ed075b10-168d-4f56-8348-4029940d7959 (2025-08-11)

**macOS:** Build it yourself. `CMSampleBuffer` delivery is per-frame but gives no multi-command atomic batch; the frame boundary is your protocol's responsibility.

### P5. Frame acknowledgement is the backpressure signal

The client acknowledges each logical frame by ID. The server uses outstanding-unacked depth to throttle, so it never out-runs the client's decode/composite rate.

- `FRAMEACKNOWLEDGE` (0x000D) in the cmdId enum, paired with the frame IDs from `STARTFRAME`/`ENDFRAME`. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/ed075b10-168d-4f56-8348-4029940d7959 (2025-08-11)

**macOS:** Build it yourself. Gate host production on client frame-ack depth, not on a producer-side timer.

---

## Part 2: Caching, so re-exposed content is never re-encoded

### P6. Content-addressed bitmap cache: store once, replay by slot

Repeated content (icons, reappearing chrome, content scrolled off then back on) should never be re-encoded after the first send. The client cache lets the server say "paint cache slot N here" for a few bytes.

- MS-RDPEGFX `SURFACETOCACHE` (0x0006) / `CACHETOSURFACE` (0x0007) stash and restore tiles via an offscreen cache; `RDPGFX_CACHE_TO_SURFACE_PDU` copies a cached bitmap (by `cacheSlot`) to each point in `destPts` with SRCCOPY. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/b2a60ac5-f4fe-4a31-855d-e7db2fab5729 (2025-08-11)
- MS-RDPBCGR persistent bitmap cache: Revision 2 caches key each bitmap by a 64-bit value derived from a cryptographic hash of its contents. Sent once via Cache Bitmap (Rev 2); thereafter referenced by key. Persistent caches survive teardown (default 10/20/30/40 MB on disk by bit depth), so a reconnect reuses prior pixels. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/2da3e165-... (2025-04-07)

**macOS:** Directly replicable as a content-hash tile cache. Hash each tile (xxHash/FNV 64-bit), keep a client LRU of decoded tiles keyed by hash; host sends "draw tile <hash> at <rect>" when resident. This is the macOS-applicable core of "cache-to-surface vs re-encode" and pairs with the dirty-tile map (P10). Persistence across sessions is an easy extra.

### P7. Glyph and fragment cache: text drawn by reference, not as pixels

Text is roughly 80% of RDP session traffic (per the Azure VDI graphics page, P9). Rasterizing every glyph to pixels every time is the single biggest avoidable cost.

- MS-RDPBCGR glyph cache capability set: 10 glyph caches (IDs 0-9) plus a fragment cache (max 256 entries x 256 bytes). Glyphs cached once, then text drawn via GlyphIndex/FastIndex orders referencing glyph IDs plus positions. With `GLYPH_SUPPORT_NONE`, "all text output will be sent to the client as expensive Bitmap Updates." https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/8e292483-... (2026-03-06)

**macOS:** Only pays off with draw-command-level remoting (glyph IDs + positions), which a framebuffer-capture pipeline like ScreenCaptureKit does not give you. For a capture-based client, the practical substitute is the content-hash tile cache (P6) applied to text tiles, which captures most of the benefit without intercepting the text-render API.

### P8. Offscreen bitmap cache: composited/scrolled surfaces reused without re-send

Scrolling and window composition repeatedly reuse offscreen surfaces; re-transmitting them per scroll step is wasteful.

- MS-RDPEGDI offscreen bitmap cache (default 100 entries, 2.5/5/7.5 MB by bit depth), manipulated by Create Offscreen Bitmap / Switch Surface orders, blitted via MemBlt/Mem3Blt. Server renders into an offscreen surface once, then composits by reference. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/63061daa-... (2024-04-23)

**macOS: this is the precedent for "retained graphics" scroll.** The analog is a retained off-screen layer (CALayer / IOSurface / Metal texture) the client holds and re-composits during scroll, so a finger-drag blits cached content instead of forcing re-encode, encoding only the newly-revealed edge tiles. A retained surface without the caching of P6 does not pay off: every desync becomes a full re-send.

---

## Part 3: Codecs, selected per region not per frame

### P9. Per-content codec selection via a classifier (the core)

A desktop frame mixes synthetic content (text, UI, sharp edges) with natural content (photos, video). One codec cannot be both visually lossless for text and bandwidth-cheap for video. MS-RDPRFX states it: text "has to be visually lossless; otherwise the text will appear blurred."

- In software encoding RDP runs "mixed-mode": each frame goes through image processors, then an **image classifier** (text vs image), then the matching codec. Per Azure Virtual Desktop: ~80% of session data is text, encoded with a custom text-optimized codec; images go to AVC/H.264 or RemoteFX; video goes to AVC/H.264. The decision is per detected region, not per whole frame. https://learn.microsoft.com/en-us/azure/virtual-desktop/graphics-encoding (ms.date 2024-10-15, updated 2025-10-23)

**macOS:** Directly replicable. Build a classifier upstream of the encoder that tags regions text vs photo/video. Route text/UI tiles to a lossless/cached path (RLE, palette, or tile cache), route photo/video tiles to VideoToolbox H.264/HEVC. VideoToolbox gives the lossy branch for free (hardware VTCompressionSession); the classifier and lossless branch are what you build.

### P10. Region/tile delta model: only changed tiles are sent

Re-encoding the full frame every refresh is wasteful when most of the screen is static.

- MS-RDPRFX RemoteFX is a tile-based DWT codec, `CT_TILE_64x64` tiles with RLGR entropy coding; tiles group into regions/tilesets and only changed tiles transmit. The AVD page calls this "delta detection." https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdprfx/ee99f7e0-bbfe-4617-9b2b-0054eeabe48f (2024-04-23)

**macOS:** Cheapest, highest-leverage win, orthogonal to codec choice. Maintain a dirty-tile map (ScreenCaptureKit already surfaces dirty rects, P11), encode only changed tiles. Does not depend on VideoToolbox.

### P11. Pixels travel as encoded wire-to-surface payloads, codec orthogonal to placement

When content is genuinely new it is compressed and addressed to a surface region so it composes with retained state. The codec stays orthogonal to the surface, move, and cache layers.

- MS-RDPEGFX `RDPGFX_WIRE_TO_SURFACE_PDU_1` carries a `codecId` per update: uncompressed 0x0000, RemoteFX/CAVIDEO 0x0003, ClearCodec 0x0008, Planar 0x000A, H.264 AVC420 0x000B / AVC444 0x000E / AVC444v2 0x000F. Different rectangles of one surface can use different codecs in the same frame. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/fb919fce-cc97-4d2b-8cf5-a737a00ef1a6 (2025-08-11)
- Capability negotiation (`RDPGFX_CAPSET_VERSION8` through 107) selects which codecs are live. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/31c6e2b1-... (2026-05-08)

**macOS:** Replicable with a tile abstraction where each tile records which encoder produced it.

### P12. AVC444: 4:4:4 text-sharp color through two 4:2:0 H.264 streams

Hardware H.264 encoders are 4:2:0 (chroma subsampled), which blurs colored text and thin lines. To get 4:4:4 fidelity on commodity 4:2:0 hardware, RDP packs two 4:2:0 substreams.

- MS-RDPEGFX `RFX_AVC444_BITMAP_STREAM` packs two `RFX_AVC420_BITMAP_STREAM` substreams (a YUV420 view and a Chroma420 view) decoded by one H.264 decoder and recombined into 4:4:4. The LC bits let the chroma substream be omitted and deferred when not needed. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/844018a5-... (2025-08-11)

**macOS:** Portable. VideoToolbox encodes 4:2:0; run the same two-view packing through one VTCompressionSession and recombine on decode. Simpler for v0: accept 4:2:0 for video regions and keep text on a separate lossless path (P9), which sidesteps the chroma problem for the content that needs sharpness.

### P13. Progressive refinement: send coarse, then refine the same tile

On constrained bandwidth you want something on screen immediately, then sharpening, rather than waiting for a full-quality tile or dropping the frame.

- MS-RDPEGFX RemoteFX Progressive applies a DWT per tile and sends progressive quality levels 25/50/100%. Stateful: keeps current-frame coefficients plus persistent progressive state tracking partially-upgraded tiles, so a later frame ships only the upgrade delta; also does difference tiles between frames. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/1dcd953d-... (2025-08-11)

**macOS:** Hardest to replicate. VideoToolbox is block-DCT (H.264/HEVC), not wavelet, and exposes no per-tile progressive upgrade. Lowest-ROI principle to copy for v0. Cheaper analog: send a low-quality region keyframe immediately, then a higher-quality re-encode when bandwidth allows, tracked by the tile cache.

---

## Part 4: The macOS damage signal (and the one capability that was removed)

This is the section that stops a naive "just be like RDP." On modern macOS the OS gives you the damage but not the move vector.

### M1. ScreenCaptureKit hands per-frame dirty rectangles, and encode-the-damage is Apple-endorsed

- `SCStreamFrameInfoDirtyRects` is a documented attachment key on each `CMSampleBuffer`. Apple's WWDC22 session 10155 ("Take ScreenCaptureKit to the next level") explicitly recommends: encode/transmit only the changed regions and copy them onto the previous frame on the receiver. That is a damage-driven remoter. https://developer.apple.com/videos/play/wwdc2022/10155/ (WWDC22, June 2022) and https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects (no page date verifiable)

### M2. dirtyRects is the UNION of moved AND redrawn rectangles, in pixel space

- The value is "an array of rectangles that is the union of both rectangles that were redrawn and rectangles that were moved," delivered as `CGRect` boxed in `NSValue`, in pixels (not points). https://docs.rs/objc2-screen-capture-kit/latest/objc2_screen_capture_kit/static.SCStreamFrameInfoDirtyRects.html (mirrors Apple headerdoc)
- Consequence: the rects align with the captured IOSurface pixel space (no point-to-pixel conversion), but the union erases the moved-vs-redrawn distinction. dirtyRects alone cannot tell you a region was a copy.

### M3. Availability: dirtyRects since macOS 12.3 (March 2022); siblings later

- `SCStreamFrameInfoStatus`, `DisplayTime`, `ScaleFactor`, `ContentScale`, `ContentRect`, `DirtyRects`: macOS 12.3. `ScreenRect`: 13.1. `BoundingRect`: 14.0. `PresenterOverlayContentRect`: 14.2. https://github.com/dotnet/macios/wiki/ScreenCaptureKit-macOS-xcode16.2-b2 (Xcode 16.2 b2, late 2024)
- Key meanings: `status` (`SCFrameStatus`) = whether the sample carries a new frame (`complete`) vs `idle`/`blank`/`suspended`. `contentRect` = content size/location within the surface, in points. `scaleFactor` = pixel-to-point scale [1,4]; dirtyRects are pixels, contentRect is points, so this is the conversion factor. `boundingRect` (14+) = smallest points box containing all captured windows.

### M4. Always gate on `status` before reading dirtyRects

- `complete` = new frame with valid pixels and meaningful dirtyRects. `idle` = no new frame because the display did not change, so no new IOSurface. Known caveat: the stream keeps delivering and developers hit unexpected `idle`. Do not treat "empty dirtyRects on a delivered buffer" as "screen static"; disambiguate with `status`. https://developer.apple.com/documentation/screencapturekit/scframestatus/idle (no date verifiable), https://developer.apple.com/forums/thread/720228

### M5. The removed capability: macOS no longer gives you the scroll/copy delta

This is the single most important macOS fact for a scroll remoter.

- Legacy `CGDisplayStream` separated damage into `kCGDisplayStreamUpdateRefreshedRects` (redrawn) and `kCGDisplayStreamUpdateMovedRects` (moved), and exposed `CGDisplayStreamUpdateGetMovedRectsDelta(updateRef, &dx, &dy)` returning the exact offset from a moved rectangle back to its source. That is the literal RDP-equivalent "this block moved by (dx, dy)" vector, ideal for emitting CopyRect-style commands. CGDisplayStream header: https://github.com/w0lfschild/cDock/blob/master/_resource/xcode/cDock-Bundle/CoreGraphics.framework/Versions/A/Headers/CGDisplayStream.h (API dates to macOS 10.8)
- `ScreenCaptureKit` collapses moved and redrawn into a single `dirtyRects` union and exposes no moved-delta accessor. `CGDisplayStream` is obsoleted in macOS 15.0, so the delta is not a fallback you can keep. Deprecation trail: https://github.com/FreeRDP/FreeRDP/issues/10558 (2024), https://issues.chromium.org/issues/327458809

**Architectural consequence.** macOS gives you changed rectangles (M1) but not a copy/scroll vector (M5). So a correct macOS scroll remoter must:
1. Read `SCStreamFrameInfoDirtyRects` as the source of "what changed" (do not pixel-diff the full frame; the OS already did that work).
2. Synthesize the scroll vector from **input scroll deltas**, which the remoter already owns, not from the capture stack.
3. Validate the predicted copy against the damage union (does shifting the band by the predicted dy explain the dirtyRects), and fall back to a redraw of the residual when it does not.
4. Emit a CopyRect/SURFACETOSURFACE-equivalent for the moved band, and encode only the newly-exposed strip.

This is the one thing neither RDP (OS gives the vector) nor old macOS (CGDisplayStream gave the delta) had to do. It is the core of a clean damage-driven design on current macOS, not a workaround.

---

## Quick map: RDP principle to macOS reality

| # | RDP principle | macOS status | Build cost |
|---|---|---|---|
| P1 | Retained surfaces | Your design (CALayer/IOSurface/Metal) | Owned |
| P2 | On-screen copy primitive | No protocol; client-side blit (RFB CopyRect model) | Owned |
| P3 | Move vector from OS | **Removed** (was CGDisplayStream; gone in SCK) | See M5 |
| P4 | Atomic frame markers | Build in your protocol | Low |
| P5 | Frame-ack backpressure | Build; gate on client ack depth | Low |
| P6 | Content-hash bitmap cache | Replicable (hash + client LRU) | Medium, high ROI |
| P7 | Glyph cache | Only with draw-command remoting; substitute P6 | N/A for capture |
| P8 | Offscreen cache for scroll | The "retained graphics" precedent | Medium |
| P9 | Per-region codec classifier | Replicable upstream of VideoToolbox | Medium, core |
| P10 | Dirty-tile delta | Cheapest win; feed from M1 dirtyRects | Low, highest ROI |
| P11 | Codec orthogonal to placement | Replicable with per-tile encoder tag | Low |
| P12 | AVC444 4:4:4 via dual 4:2:0 | Portable; or keep text on lossless path | Medium |
| P13 | Wavelet progressive refine | Hard (VideoToolbox is block-DCT) | High, low ROI |

## Highest-ROI, directly-portable set

For a macOS capture-based remoter, in priority order: dirty-tile delta detection fed by `dirtyRects` (P10 + M1), a content-hash tile cache for cache-to-surface reuse (P6), per-region routing to lossless/cached vs VideoToolbox (P9/P11), a retained off-screen surface for scroll (P8), and the input-fused-with-damage scroll vector that replaces the removed OS delta (M5). Skip wavelet progressive (P13) and true glyph caching (P7) for v0; the tile cache substitutes for both.

## Source index

Microsoft Learn open-spec and Azure VDI pages (dates are page `updated_at`):
- MS-RDPEGFX cmdId enum / frame markers: ed075b10-168d-4f56-8348-4029940d7959 (2025-08-11)
- MS-RDPEGFX SURFACETOSURFACE: 0b19d058-fff0-43e5-8671-8c4186d60529 (2025-08-11)
- MS-RDPEGFX WIRETOSURFACE_1 codecId table: fb919fce-cc97-4d2b-8cf5-a737a00ef1a6 (2025-08-11)
- MS-RDPEGFX CACHETOSURFACE: b2a60ac5-f4fe-4a31-855d-e7db2fab5729 (2025-08-11)
- MS-RDPEGFX surface management: 5229ee1e-1cb4-4178-9739-a36f1258b685 (2025-08-11)
- MS-RDPEGFX RemoteFX Progressive: 1dcd953d (2025-08-11)
- MS-RDPEGFX AVC444 stream: 844018a5 (2025-08-11)
- MS-RDPEGFX capability negotiation: 31c6e2b1 (2026-05-08)
- MS-RDPEGFX landing v19.0: da5c75f9-cd99-450c-98c4-014a496942b0 (2026-05-08)
- MS-RDPEGDI ScrBlt: a4e322b0-cd64-4dfc-8e1a-f24dc0edc99d (2024-04-23)
- MS-RDPEGDI order-type table: 23f766d4-8343-4e6b-8281-071ddccc0272 (2024-04-23)
- MS-RDPEGDI offscreen cache: 63061daa (2024-04-23)
- MS-RDPRFX RemoteFX codec: ee99f7e0-bbfe-4617-9b2b-0054eeabe48f (2024-04-23)
- MS-RDPBCGR persistent bitmap cache: 2da3e165 (2025-04-07)
- MS-RDPBCGR glyph cache: 8e292483 (2026-03-06)
- Azure VDI graphics encoding: https://learn.microsoft.com/en-us/azure/virtual-desktop/graphics-encoding (2024-10-15 / 2025-10-23)

Windows capture stack:
- DXGI GetFrameMoveRects: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-getframemoverects (2024-02-22)
- DXGI GetFrameDirtyRects: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-getframedirtyrects
- Mirror driver: https://learn.microsoft.com/en-us/troubleshoot/windows-hardware/drivers/loading-starting-graphics-mirror-driver

macOS:
- WWDC22 session 10155: https://developer.apple.com/videos/play/wwdc2022/10155/
- SCStreamFrameInfoDirtyRects: https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects
- dirtyRects union semantics mirror: https://docs.rs/objc2-screen-capture-kit/latest/objc2_screen_capture_kit/static.SCStreamFrameInfoDirtyRects.html
- SCStreamFrameInfo availability: https://github.com/dotnet/macios/wiki/ScreenCaptureKit-macOS-xcode16.2-b2
- SCFrameStatus.idle: https://developer.apple.com/documentation/screencapturekit/scframestatus/idle
- CGDisplayStream moved-rects delta (removed): https://github.com/w0lfschild/cDock/blob/master/_resource/xcode/cDock-Bundle/CoreGraphics.framework/Versions/A/Headers/CGDisplayStream.h
- CGDisplayStream obsoletion trail: https://github.com/FreeRDP/FreeRDP/issues/10558 , https://issues.chromium.org/issues/327458809

RFB/VNC:
- RFC 6143 CopyRect: https://www.rfc-editor.org/rfc/rfc6143.html (2011-03)
