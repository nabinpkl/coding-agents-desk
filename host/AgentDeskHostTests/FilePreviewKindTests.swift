import Foundation
import XCTest
@testable import AgentDeskHost

final class FilePreviewKindTests: XCTestCase {
    func testDocxIsAReadOnlyDocumentPreview() {
        XCTAssertEqual(FilePreviewKind.classify(file("Report.DOCX")), .docx)
        XCTAssertTrue(FilePreviewKind.docx.isReadOnly)
    }

    func testClassifiesHTMLFilesForNativePreview() {
        XCTAssertEqual(FilePreviewKind.classify(file("index.html")), .html)
        XCTAssertEqual(FilePreviewKind.classify(file("legacy.HTM")), .html)
    }

    func testClassifiesMarkdownFilesForRenderedPreview() {
        XCTAssertEqual(FilePreviewKind.classify(file("README.md")), .markdown)
        XCTAssertEqual(FilePreviewKind.classify(file("notes.markdown")), .markdown)
    }

    func testClassifiesNotebooksForCellPreview() {
        XCTAssertEqual(FilePreviewKind.classify(file("analysis.ipynb")), .notebook)
        XCTAssertEqual(FilePreviewKind.classify(file("Untitled.IPYNB")), .notebook)
    }

    func testFallsBackToTextEditorSurface() {
        XCTAssertEqual(FilePreviewKind.classify(file("main.swift")), .text)
        XCTAssertEqual(FilePreviewKind.classify(file("Makefile")), .text)
    }

    private func file(_ name: String) -> URL {
        URL(fileURLWithPath: "/tmp/\(name)")
    }
}
