import Foundation
import XCTest
@testable import AgentDeskHost

final class FileTabTests: XCTestCase {
    func testTabDoesNotRetainWebSurfaces() {
        let tab = FileTab(identity: .source(file("note.txt")))
        let storedProperties = Set(Mirror(reflecting: tab).children.compactMap(\.label))

        XCTAssertFalse(storedProperties.contains("editorSurface"))
        XCTAssertFalse(storedProperties.contains("htmlSurface"))
    }

    func testSaveFailureKeepsDirtyBufferAndSurfacesError() {
        let tab = FileTab(identity: .source(file("note.txt")))

        tab.markDirty("edited")
        tab.beginSave()
        tab.markSaveFailed("could not write note.txt")

        XCTAssertEqual(tab.diskState, .saveFailed("could not write note.txt"))
        XCTAssertEqual(tab.text, "edited")
        XCTAssertTrue(tab.dirty)
        XCTAssertFalse(tab.saving)
        XCTAssertFalse(tab.savedOnce)
        XCTAssertEqual(tab.saveError, "could not write note.txt")
    }

    func testSaveSuccessClearsDirtyStateAndError() {
        let tab = FileTab(identity: .source(file("note.txt")))

        tab.markDirty("edited")
        tab.markSaveFailed("previous failure")
        tab.beginSave()
        tab.markSaved()

        XCTAssertEqual(tab.diskState, .clean(savedOnce: true))
        XCTAssertEqual(tab.text, "edited")
        XCTAssertFalse(tab.dirty)
        XCTAssertFalse(tab.saving)
        XCTAssertTrue(tab.savedOnce)
        XCTAssertNil(tab.saveError)
    }

    func testExternalModifyAndUseDiskTransitions() {
        let tab = FileTab(identity: .source(file("note.txt")))

        tab.markDirty("mine")
        tab.markChangedOnDisk("disk")

        XCTAssertEqual(tab.diskState, .changedOnDisk("disk"))
        XCTAssertFalse(tab.dirty)
        XCTAssertEqual(tab.conflictText, "disk")

        tab.useDisk("disk")

        XCTAssertEqual(tab.text, "disk")
        XCTAssertEqual(tab.diskState, .clean(savedOnce: true))
        XCTAssertNil(tab.conflictText)
    }

    func testKeepMineReturnsToDirtyState() {
        let tab = FileTab(identity: .source(file("note.txt")))

        tab.markChangedOnDisk("disk")
        tab.keepMine()

        XCTAssertEqual(tab.diskState, .dirty)
        XCTAssertTrue(tab.dirty)
        XCTAssertNil(tab.conflictText)
    }

    func testDeletedOnDiskTracksWhetherBufferCanRecreate() {
        let clean = FileTab(identity: .source(file("clean.txt")))
        clean.markLoaded()
        clean.markDeletedOnDisk()

        XCTAssertEqual(clean.diskState, .deletedOnDisk(canRecreate: false))
        XCTAssertFalse(clean.dirty)
        XCTAssertTrue(clean.deleted)

        let dirty = FileTab(identity: .source(file("dirty.txt")))
        dirty.markDirty("edited")
        dirty.markDeletedOnDisk()

        XCTAssertEqual(dirty.diskState, .deletedOnDisk(canRecreate: true))
        XCTAssertTrue(dirty.dirty)
        dirty.saveToRecreate()
        XCTAssertEqual(dirty.diskState, .dirty)
    }

    private func file(_ name: String) -> URL {
        URL(fileURLWithPath: "/tmp/\(name)")
    }
}
