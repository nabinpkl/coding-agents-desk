import AgentDeskWire

struct AgentTerminalResponseFence: Sendable {
    private(set) var activeRequest: AgentTerminalOpen?

    mutating func begin(_ request: AgentTerminalOpen) {
        activeRequest = request
    }

    mutating func contextChanged(to context: AgentResumeTerminalContext) {
        guard activeRequest?.context != context else { return }
        activeRequest = nil
    }

    mutating func accept(_ message: AgentTerminalHostMessage) -> AgentTerminalHostMessage? {
        guard let activeRequest,
              message.requestID == activeRequest.requestID,
              message.context == activeRequest.context else {
            return nil
        }

        switch message {
        case .ready:
            return message
        case .ended, .error:
            self.activeRequest = nil
            return message
        }
    }
}
