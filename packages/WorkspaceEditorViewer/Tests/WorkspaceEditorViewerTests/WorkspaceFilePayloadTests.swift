import Foundation
import Testing
import WorkspaceKit
@testable import WorkspaceEditorViewer

@Test func fileKindClassificationHasOneSharedDOCXCase() {
    #expect(WorkspaceFileKind(path: "Reports/Plan.DOCX") == .docx)
    #expect(WorkspaceFileKind(path: "README.md") == .markdown)
    #expect(WorkspaceFileKind(path: "analysis.ipynb") == .notebook)
    #expect(WorkspaceFileKind(path: "main.swift") == .text)
}

@Test func docxPayloadPublishesAnOpaqueAppResourceURL() {
    let store = WorkspaceFileResourceStore()
    let payload = WorkspaceFilePayload(
        id: "report.docx",
        name: "report.docx",
        path: "report.docx",
        workspace: "Demo",
        root: "",
        content: .documentData(Data([0x50, 0x4b])),
        kind: .docx,
        mode: .preview
    )

    let resourceURL = store.publish(payload.content)
    let dictionary = payload.dictionary(resourceURL: resourceURL)

    #expect(dictionary["kind"] as? String == "docx")
    #expect(dictionary["mode"] as? String == "preview")
    #expect(dictionary["text"] == nil)
    #expect((dictionary["resourceURL"] as? String)?.hasPrefix("app://app/document/") == true)
    #expect(!(dictionary["resourceURL"] as? String ?? "").contains("report.docx"))
}

@Test func localDocumentResourceKeepsItsReadCeiling() throws {
    let store = WorkspaceFileResourceStore()
    let fileURL = URL(fileURLWithPath: "/tmp/report.docx")
    let resourceURL = try #require(store.publish(.documentFile(fileURL, maximumBytes: 4096)))
    let token = try #require(resourceURL.pathComponents.last)

    guard case .file(let storedURL, let maximumBytes)? = store.resource(for: token) else {
        Issue.record("expected a bounded file resource")
        return
    }
    #expect(storedURL == fileURL)
    #expect(maximumBytes == 4096)
}
