import UIKit

struct KeyboardDeckMetrics: Equatable {
    let keycapHeight: CGFloat
    let verticalRowGap: CGFloat
    let horizontalKeyGap: CGFloat
    let horizontalDeckInset: CGFloat
    let topDeckPadding: CGFloat
    let bottomDeckPadding: CGFloat
    let alphabetOuterKeyGap: CGFloat
    let deckHeight: CGFloat
    let toolbarMinimumHeight: CGFloat
    let sectionSpacing: CGFloat
    let inputTopInset: CGFloat
    let inputBottomInset: CGFloat

    static let portrait = KeyboardDeckMetrics(
        keycapHeight: 46,
        verticalRowGap: 10,
        horizontalKeyGap: 6,
        horizontalDeckInset: 7,
        topDeckPadding: 14,
        bottomDeckPadding: 8,
        alphabetOuterKeyGap: 10,
        deckHeight: 236,
        toolbarMinimumHeight: 72,
        sectionSpacing: 8,
        inputTopInset: 7,
        inputBottomInset: 7
    )

    static let compactLandscape = KeyboardDeckMetrics(
        keycapHeight: 44,
        verticalRowGap: 5,
        horizontalKeyGap: 4,
        horizontalDeckInset: 7,
        topDeckPadding: 6,
        bottomDeckPadding: 4,
        alphabetOuterKeyGap: 8,
        deckHeight: 201,
        toolbarMinimumHeight: 60,
        sectionSpacing: 5,
        inputTopInset: 5,
        inputBottomInset: 5
    )

    func inputHeight(
        toolbarHeight: CGFloat,
        reviewEditorHeight: CGFloat?
    ) -> CGFloat {
        inputTopInset
            + toolbarHeight
            + sectionSpacing
            + (reviewEditorHeight.map { $0 + sectionSpacing } ?? 0)
            + deckHeight
            + inputBottomInset
    }
}
