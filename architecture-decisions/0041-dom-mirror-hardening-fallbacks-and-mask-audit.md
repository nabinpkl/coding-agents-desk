---
status: proposed
date: 2026-07-01
---

# DOM-mirror password masking, pixel fallback, asset reachability, data audit

## Context and Problem Statement

The first DOM mirror masked all page text, form values, and human-readable attributes before sending
them to the phone. That was a conservative v1 privacy choice for arbitrary Chrome tabs, but it also
made the reconstructed browser unsuitable as a readable projection. The later macOS Browser
Projection uses the same recorder and batches as the remote page-only projection, so there is no
separate local payload whose masking can be removed independently.

The useful contract is narrower: ordinary browser content must remain visible, while password input
values must never leave the Chrome extension as plaintext or enter diagnostic logs. Canvas/WebGL,
video, cross-origin iframes, and authenticated assets remain separate fidelity problems.

## Decision Drivers

- Fidelity: visible text, ordinary form values, and accessible attributes must reconstruct verbatim.
- Password safety: static and incremental `input[type=password]` values must be masked before egress.
- One recorder: local AgentDesk and the connected iOS client consume the same selected-tab batches.
- Payload opacity: the bridge and host relay must not log DOM payload contents.
- Keep the DOM lane decoupled from the media path.

## Considered Options

- **Content policy**: (A) mask all human-readable content; (B) expose ordinary content and mask only
  password inputs; (C) split local and remote capture into separate payloads.
- **Pixel content**: (A) composite the existing media stream into unrepresentable regions now; (B)
  defer behind a region-signal interface.
- **Asset reachability**: (A) inline images and fonts; (B) keep URL references and defer an asset
  proxy.

## Decision Outcome

**Content policy: Option B.** The rrweb recorder preserves ordinary text, form values, and attributes.
It passes `maskAllInputs: { password: true }`, so rrweb masks password values in full snapshots and
incremental input or attribute mutations before events reach the service worker. The CDP Tier B
serializer applies the same rule to both an input's `value` attribute and `DOMSnapshot.inputValue`
when the element is `input[type=password]`. Ordinary CDP text, fields, titles, alt text, ARIA labels,
and placeholders remain visible.

The extension does not log events, reconstructed HTML, or batches. The native shim only reframes
payloads. The host probe records envelope facts such as tab ID, generation, checkout flag, and byte
count, never payload content. Batches remain available in memory for local reconstruction, remote
relay, and late join.

Because the recorder is shared, ordinary page content now also reaches a connected, authenticated
iOS projection over its encrypted session. A future product requirement for different local and
remote visibility would require separate capture policies or payloads; this iteration does not add
that duplicate state.

**Pixel content: Option B (deferred).** Canvas/WebGL, video, and cross-origin iframe regions remain
blank. A future pixel fallback can identify those rectangles and composite the owned-media stream
without coupling the DOM and media transports.

**Asset reachability: Option B (partial).** `inlineStylesheet` carries CSS, while images and fonts
remain URL-referenced. Public assets work; cookie-gated and localhost-only assets need a future
credential-aware asset proxy.

### Consequences

- Good: reconstructed pages are readable and ordinary forms reflect their live values.
- Good: passwords are masked at the source on both rrweb and CDP paths, before compression or relay.
- Good: diagnostics contain envelope metadata only, not DOM payloads.
- Bad: email bodies, chat, account data, and other non-password page content are intentionally sent
  to the connected client while projection is enabled.
- Bad: secrets placed in ordinary text, non-password inputs, attributes, or URLs are not inferred or
  redacted. The browser cannot reliably distinguish those from content the user asked to project.

### Confirmation

`just dom-mirror-record-verify` records a real fixture through the unpacked extension, native shim,
and fake host. After decompressing the real rrweb events it asserts visible text, an ordinary text
input, and a title attribute are present, while static and post-snapshot password values are absent.
The post-snapshot check exercises property input and explicit `value` attribute mutation.

`just dom-mirror-cdp-verify` captures a real `DOMSnapshot` containing light and closed-shadow DOM. It
asserts ordinary text, fields, and attributes survive reconstruction while light-DOM and closed-shadow
password values do not.

### Projection-data audit

- **Masked before egress:** values belonging to `input[type=password]`, including initial values,
  incremental rrweb input/attribute changes, and CDP `inputValue` or `value` attributes.
- **Sent as projection content:** visible text, ordinary input/select/textarea values, title/alt/ARIA/
  placeholder attributes, DOM structure, layout attributes, URLs, CSS, and the selected tab metadata.
- **Not written to diagnostics:** rrweb events, CDP HTML, form values, and DOM batch payloads. Logs
  contain errors, timing, identifiers, generations, flags, and byte counts only.
- **Not representable / not sent:** canvas and WebGL pixels, video frames, and cross-origin iframe
  content.

## Links

- ADR-0038 DOM mirror over a dedicated reliable QUIC lane
- ADR-0040 trusted Chrome input via chrome.debugger
- ADR-0042 isolated-world DOM recorder
- ADR-0044 tiered DOM-mirror fidelity
- rrweb privacy options: https://github.com/rrweb-io/rrweb/blob/master/guide.md#privacy
