import Foundation
import Testing

struct JsonlChildProcessTests {
    @Test func handlesChunkedStdoutLines() {
        var lines: [String] = []
        let child = JsonlChildProcess(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            category: "test-child",
            onLine: { line in
                lines.append(line)
            }
        )

        child.receiveStdout(Data(#"{"type":"ready""#.utf8))
        child.receiveStdout(Data((#","protocol":1}"# + "\n").utf8))

        #expect(lines == [#"{"type":"ready","protocol":1}"#])
    }

    @Test func dropsOversizedStdoutLineAndKeepsLaterLines() {
        var lines: [String] = []
        let child = JsonlChildProcess(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            category: "test-child",
            maxLineBytes: 8,
            onLine: { line in
                lines.append(line)
            }
        )

        child.receiveStdout(Data("123456789".utf8))
        child.receiveStdout(Data(("ok" + "\n").utf8))

        #expect(lines == ["ok"])
    }
}
