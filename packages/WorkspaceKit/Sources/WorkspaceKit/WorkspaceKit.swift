import AgentDeskWire

/// WorkspaceKit namespace. The shared workspace + files data model lands here in Phase B
/// (ADR-0054): identity, directory entries, file revision, contents, preview kind, and
/// editor/save state, reconciled with `AgentDeskWire`. Skeleton for now so both the host and
/// client targets can link the package before any types move in.
public enum WorkspaceKit {
    /// The `AgentDeskWire` protocol version this data model is built against. A compile-time
    /// touch of a shared wire type so the skeleton proves the dependency resolves from both
    /// app targets, not just a bare empty module.
    public static var wireProtocolVersion: Int { WireProtocol.version }
}
