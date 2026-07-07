// Canonical wire-protocol constants (ADR-0050, ADR-0020/0030). Single source of
// truth for the values the wire types embed; each app's Config references these.
public enum WireProtocol {
    public static let version = 5
    public static let minCompatibleVersion = 5
    public static let sessionQuicALPN = "agentdesk-session-quic-v2"
}
