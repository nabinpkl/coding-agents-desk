import Foundation

/// The agent-feed relay envelope: a request and its streamed response, carrying no
/// knowledge of what either contains.
///
/// The panel used to reach the sidecar through a typed message per operation, which
/// meant the model was restated twice in Swift -- once in long keys against the
/// sidecar, once in abbreviated keys on the wire -- with a renaming layer between
/// them. Adding a field to a payload edited both restatements and the renamer, and
/// per-side tests passed on both sides of every drift.
///
/// Here the host attaches a bearer header, checks the path against an allow-list,
/// and copies bytes. It never names a field, so a new field is a sidecar change and
/// a panel change, and nothing in between rebuilds.
///
/// Swift stays in the path for one reason worth stating: the sidecar's control token
/// is a capability the host mints per spawn and the sidecar deletes from its own
/// environment, so model-authored bash cannot reach the control API. Handing that
/// token to a page that renders agent-authored markdown would undo it. The relay
/// holds the token; the webview never sees it.
public enum AgentFeedRelay {
    /// What a request may address. This allow-list is the security boundary that
    /// keeps the relay from being an open local proxy, so it is deliberately narrow:
    /// a path under the sidecar's own API, no traversal, no authority component, and
    /// one of the two methods its routes serve.
    public enum PathPolicy {
        public static let prefix = "/api/"
        public static let allowedMethods: Set<String> = ["GET", "POST"]
        /// Matches the sidecar's own body cap, so an oversized body is refused before
        /// it is copied rather than after.
        public static let maximumBodyBytes = 256 * 1024

        /// Whether `path` may be relayed. Rejects anything that could name a host, a
        /// scheme, or a parent directory, which is what would turn "reach the sidecar"
        /// into "reach anything the host can reach".
        public static func allows(path: String) -> Bool {
            guard path.hasPrefix(prefix) else { return false }
            guard !path.contains("..") else { return false }
            guard !path.contains("://") else { return false }
            guard !path.hasPrefix("//") else { return false }
            // A backslash is not a path separator here, but it is one to some
            // resolvers; refusing it keeps this check the only thing that has to be
            // right about the path.
            guard !path.contains("\\") else { return false }
            return true
        }

        public static func allows(method: String) -> Bool {
            allowedMethods.contains(method.uppercased())
        }
    }

    /// How many relayed transfers may be in flight at once, and how long one may take.
    ///
    /// Carried over from the raw-event transfer limits this relay subsumes. A raw event used to
    /// have its own fragmenter, reassembler, and part frames on the wire because it was the one
    /// payload big enough to need splitting; ordinary chunking covers it now, so what survives of
    /// that machinery is these two numbers.
    public static let maximumConcurrentTransfers = 4
    public static let transferTimeout: TimeInterval = 30

    /// The largest body chunk a single frame carries.
    ///
    /// Well under the lane's frame ceiling so the JSON envelope, its escaping, and the
    /// base64 alphabet all fit alongside the payload with room to spare.
    public static let chunkBytes = 1024 * 1024
}

/// Panel -> host. One request against the sidecar.
public struct AgentFeedRelayRequest: Codable, Equatable, Sendable {
    public let type = "agent-http-req"
    /// Correlates every response frame with this request, and is what `agent-http-cancel`
    /// names. Chosen by the panel.
    public let rid: String
    public let method: String
    /// Path and query, rooted at the sidecar. Checked against `PathPolicy` before use.
    public let path: String
    /// A JSON request body, already serialized. Absent for GET.
    public let body: String?
    /// True for a subscription: the response is followed until cancelled, and each
    /// server-sent message arrives as its own chunk. False for a one-shot request,
    /// whose body arrives as one or more chunks and then ends.
    public let stream: Bool

    public init(rid: String, method: String, path: String, body: String? = nil, stream: Bool = false) {
        self.rid = rid
        self.method = method
        self.path = path
        self.body = body
        self.stream = stream
    }

    private enum CodingKeys: String, CodingKey {
        case type, rid, method, path, body, stream
    }
}

/// Panel -> host. Abandons an in-flight request; the host cancels the transfer.
public struct AgentFeedRelayCancel: Codable, Equatable, Sendable {
    public let type = "agent-http-cancel"
    public let rid: String

    public init(rid: String) {
        self.rid = rid
    }

    private enum CodingKeys: String, CodingKey {
        case type, rid
    }
}

/// Host -> panel. The response status, sent once, before any chunk.
public struct AgentFeedRelayHead: Codable, Equatable, Sendable {
    public let type = "agent-http-head"
    public let rid: String
    public let status: Int

    public init(rid: String, status: Int) {
        self.rid = rid
        self.status = status
    }

    private enum CodingKeys: String, CodingKey {
        case type, rid, status
    }
}

/// Host -> panel. One piece of the response body.
///
/// `seq` counts from zero per request so the panel can assert it reassembled the
/// body in order rather than trusting lane ordering silently.
public struct AgentFeedRelayChunk: Codable, Equatable, Sendable {
    public let type = "agent-http-chunk"
    public let rid: String
    public let seq: Int
    /// Response bytes as text. Every sidecar route answers JSON or UTF-8 plain text,
    /// and a chunk boundary never splits a character: the relay backs a split up to
    /// the nearest boundary rather than emitting half of one.
    public let data: String
    /// True on the chunk that completes a body.
    ///
    /// A one-shot response ends here and `agent-http-end` follows. A subscription does
    /// not end -- this marks the end of ONE server-sent message, and the next message's
    /// chunks follow on the same `rid`. Without it a reader could not tell a message
    /// boundary from a chunk boundary, and would parse two halves of one message as
    /// one malformed whole.
    public let complete: Bool

    public init(rid: String, seq: Int, data: String, complete: Bool) {
        self.rid = rid
        self.seq = seq
        self.data = data
        self.complete = complete
    }

    private enum CodingKeys: String, CodingKey {
        case type, rid, seq, data, complete
    }
}

/// Host -> panel. The response is complete; no further frames carry this `rid`.
public struct AgentFeedRelayEnd: Codable, Equatable, Sendable {
    public let type = "agent-http-end"
    public let rid: String

    public init(rid: String) {
        self.rid = rid
    }

    private enum CodingKeys: String, CodingKey {
        case type, rid
    }
}

/// Host -> panel. The request failed, at any point. Terminal for this `rid`.
public struct AgentFeedRelayError: Codable, Equatable, Sendable {
    public let type = "agent-http-err"
    public let rid: String
    public let reason: String

    public init(rid: String, reason: String) {
        self.rid = rid
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case type, rid, reason
    }
}
