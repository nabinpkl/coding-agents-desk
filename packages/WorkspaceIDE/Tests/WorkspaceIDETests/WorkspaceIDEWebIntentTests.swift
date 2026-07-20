import Foundation
import Testing
@testable import WorkspaceIDE

@Test func webIntentParsingIsStrict() throws {
    #expect(try WorkspaceIDEWebIntent.parse([
        "type": "setDirectoryExpanded", "path": "Sources", "expanded": true,
    ]) == .setDirectoryExpanded(path: "Sources", expanded: true))
    #expect(try WorkspaceIDEWebIntent.parse([
        "type": "toggleMode", "path": "README.md",
    ]) == .toggleMode(path: "README.md"))
    #expect(throws: WorkspaceIDEWebIntent.ParseError.invalid("expanded")) {
        try WorkspaceIDEWebIntent.parse([
            "type": "setDirectoryExpanded", "path": "Sources", "expanded": "yes",
        ])
    }
    #expect(throws: WorkspaceIDEWebIntent.ParseError.unknownType("hostPath")) {
        try WorkspaceIDEWebIntent.parse(["type": "hostPath", "path": "/tmp"])
    }
}

@Test func localLayoutStateClampsFractions() {
    var state = WorkspaceIDELocalState(sidebarFraction: 1, terminalFraction: 0)
    #expect(state.sidebarFraction == 0.55)
    #expect(state.terminalFraction == 0.18)
    state.setSidebarFraction(0.1)
    state.setTerminalFraction(0.9)
    #expect(state.sidebarFraction == 0.18)
    #expect(state.terminalFraction == 0.72)
}

@Test func localZoomStateClampsAndOldStoredStateDefaultsToActualSize() throws {
    var state = WorkspaceIDELocalState(zoomStep: 99)
    #expect(state.zoomScale == 2)

    for _ in 0..<30 { state.zoomOut() }
    #expect(state.zoomScale == 0.6)

    let oldJSON = Data(#"""
    {
        "selectedWorkspaceID": null,
        "activePathByWorkspace": {},
        "previewPathsByWorkspace": {},
        "sidebarSection": "explorer",
        "sidebarVisible": true,
        "terminalVisible": true,
        "sidebarFraction": 0.28,
        "terminalFraction": 0.36
    }
    """#.utf8)
    let restored = try JSONDecoder().decode(WorkspaceIDELocalState.self, from: oldJSON)

    #expect(restored.zoomScale == 1)
}
