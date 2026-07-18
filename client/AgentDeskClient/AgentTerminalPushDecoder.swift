import Foundation
import AgentDeskWire

enum AgentTerminalPushDecoder {
    static func decode(_ data: Data) -> AgentTerminalHostMessage? {
        try? JSONDecoder().decode(AgentTerminalHostMessage.self, from: data)
    }
}
