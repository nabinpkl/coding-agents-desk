// The one question about a peer's connection state that more than one file asks.
//
// `disconnected` is explicitly transient -- the browser owns an eight-second reconnect window --
// so only these two mean the peer is gone for good. Its own file because the answer, the sessions
// census and the route each act on it, and a second copy would be the one that disagreed.

export function isTerminalWebrtcConnectionState(state: string): boolean {
  return state === "failed" || state === "closed";
}
