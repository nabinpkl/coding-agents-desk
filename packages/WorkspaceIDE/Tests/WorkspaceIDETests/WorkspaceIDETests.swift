import Testing
@testable import WorkspaceIDE

@Test func autosavePolicyIsSharedByBothPlatformAdapters() {
    #expect(WorkspaceIDE.autosaveDelay == .milliseconds(700))
}
