import Foundation
import OSLog
import Testing

@testable import AgentDeskClient

@Suite struct OSLogDrainPolicyTests {
    // The level the code already chose is the classification, so nothing new has to be
    // annotated: `.notice` upward is what the dial and session paths use for lines worth
    // reading later, and `.debug`/`.info` is where per-frame chatter goes.
    @Test func noticeAndAboveSurviveTheBudgetThatSacrificesChatter() {
        #expect(OSLogDrainPolicy.retention(for: .notice) == .lifecycle)
        #expect(OSLogDrainPolicy.retention(for: .error) == .lifecycle)
        #expect(OSLogDrainPolicy.retention(for: .fault) == .lifecycle)
    }

    @Test func debugAndInfoAreSacrificedFirst() {
        #expect(OSLogDrainPolicy.retention(for: .debug) == .stream)
        #expect(OSLogDrainPolicy.retention(for: .info) == .stream)
        #expect(OSLogDrainPolicy.retention(for: .undefined) == .stream)
    }

    // `position(date:)` is inclusive, so the boundary entry comes back on the next drain. It
    // has to be dropped, or every drain stores its first entry a second time.
    @Test func theEntryTheLastDrainEndedOnIsNotTakenTwice() {
        let boundary = Date(timeIntervalSince1970: 1_800_000_000)

        #expect(!OSLogDrainPolicy.shouldEmit(entryDate: boundary, after: boundary))
        #expect(!OSLogDrainPolicy.shouldEmit(
            entryDate: boundary.addingTimeInterval(-1),
            after: boundary
        ))
        #expect(OSLogDrainPolicy.shouldEmit(
            entryDate: boundary.addingTimeInterval(0.001),
            after: boundary
        ))
    }

    @Test func theFirstDrainOfAProcessTakesEverythingItFinds() {
        #expect(OSLogDrainPolicy.shouldEmit(
            entryDate: Date(timeIntervalSince1970: 0),
            after: nil
        ))
    }

    @Test func fieldsCarryTheCategoryLevelAndMessage() {
        let fields = OSLogDrainPolicy.fields(
            category: "link-telemetry",
            level: .notice,
            message: "dial phases connect=8412 total=8600"
        )

        #expect(fields == [
            "category": "link-telemetry",
            "level": "notice",
            "message": "dial phases connect=8412 total=8600"
        ])
    }

    // The store mirrors every recorded event back out through Logger, so a drain that did not
    // exclude that category would re-record its own output on every tick, forever.
    @Test func theStoresOwnMirrorCategoryIsTheOneTheDrainExcludes() {
        #expect(Config.diagnosticsLogCategory == "client-diagnostics")
    }
}
