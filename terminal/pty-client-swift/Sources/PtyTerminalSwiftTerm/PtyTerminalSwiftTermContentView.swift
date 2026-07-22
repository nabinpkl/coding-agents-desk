import Foundation
import PtyClientSwift
import PtyTerminalSession
import SwiftTerm

#if canImport(AppKit)
import AppKit
public typealias PtyTerminalContentPlatformView = NSView
private typealias PtyTerminalPlatformLabel = NSTextField
#elseif canImport(UIKit)
import UIKit
public typealias PtyTerminalContentPlatformView = UIView
private typealias PtyTerminalPlatformLabel = UILabel
#endif

@MainActor
public protocol PtyTerminalSwiftTermContentViewDelegate: AnyObject {
    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didSetTitle title: String)
    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didReceiveStatus text: String)
    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didFail error: Error)
    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    )
    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView)
}

public extension PtyTerminalSwiftTermContentViewDelegate {
    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didSetTitle title: String) {}
    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didReceiveStatus text: String) {}
    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didFail error: Error) {}
    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {}
    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {}
}

@MainActor
public final class PtyTerminalSwiftTermContentView: PtyTerminalContentPlatformView,
    @MainActor TerminalViewDelegate,
    PtyTerminalRenderer
{
    public weak var delegate: PtyTerminalSwiftTermContentViewDelegate?

    let terminalView: TerminalView
    private let canvasView: PtyTerminalContentPlatformView
    public var isInputEnabled = true
    public private(set) var isBound = false
    public private(set) var rendererSetupError: Error?
    private(set) var bindingGeneration: UInt64 = 0
    public private(set) var authoritativeDimensions = PtyTerminalDimensions.bootstrap
    public private(set) var appliedRevision: UInt64 = 0
    public private(set) var fitScale: CGFloat = 1
    public private(set) var viewportOrigin = CGPoint.zero
    public private(set) var isViewportCropped = false

    public var columns: Int { terminalView.getTerminal().cols }
    public var rows: Int { terminalView.getTerminal().rows }
    public var attachmentDimensions: PtyTerminalDimensions {
        synchronizeLayout()
        guard !bounds.isEmpty else { return .bootstrap }
        let currentColumns = max(columns, 1)
        let currentRows = max(rows, 1)
        let optimal = terminalView.getOptimalFrameSize().size
        guard optimal.width > 0, optimal.height > 0 else { return .bootstrap }
        let cellWidth = optimal.width / CGFloat(currentColumns)
        let cellHeight = optimal.height / CGFloat(currentRows)
        guard cellWidth > 0, cellHeight > 0 else { return .bootstrap }
        return PtyTerminalDimensions(
            columns: UInt32(min(max(Int(bounds.width / cellWidth), 1), 512)),
            rows: UInt32(min(max(Int(bounds.height / cellHeight), 1), 256))
        )
    }

    private var sessionDriver: PtyTerminalSessionDriver?
    private var isApplyingManagerData = false
    public private(set) var isSynchronizing = true
    private let sizeControl = PtyTerminalSizeControl()
    private let syncStatus = PtyTerminalPlatformLabel()
    private let historyStatus = PtyTerminalPlatformLabel()

    public init(
        style: PtyTerminalViewStyle = PtyTerminalViewStyle(
            metalRendering: PtyTerminalMetalRendering.from()
        )
    ) {
        let nativeView = PtyTerminalNativeView(
            frame: .zero,
            font: PtyTerminalViewStyle.terminalFont(pointSize: style.fontSize)
        )
        terminalView = nativeView
        canvasView = PtyTerminalContentPlatformView(frame: .zero)
        super.init(frame: .zero)

        do {
            try style.apply(to: nativeView)
        } catch {
            rendererSetupError = error
        }
        nativeView.translatesAutoresizingMaskIntoConstraints = false
        nativeView.terminalDelegate = self
        nativeView.changeScrollback(2_000)
        #if canImport(AppKit)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Agent terminal")
        setAccessibilityHelp("Press to focus the native terminal.")
        nativeView.pasteHandler = { [weak self] text in self?.paste(text: text) }
        #endif
        addSubview(canvasView)
        canvasView.addSubview(nativeView)
        canvasView.translatesAutoresizingMaskIntoConstraints = true
        nativeView.translatesAutoresizingMaskIntoConstraints = true
        nativeView.isHidden = true
        #if canImport(AppKit)
        wantsLayer = true
        layer?.masksToBounds = true
        canvasView.wantsLayer = true
        canvasView.layer?.masksToBounds = true
        nativeView.wantsLayer = true
        #elseif canImport(UIKit)
        clipsToBounds = true
        canvasView.clipsToBounds = true
        #endif
        configureOverlayControls()

        #if canImport(UIKit)
        backgroundColor = .black
        nativeView.backgroundColor = PtyTerminalViewStyle.defaultBackgroundColor
        nativeView.contentInsetAdjustmentBehavior = .never
        nativeView.keyboardDismissMode = .interactive
        nativeView.alwaysBounceVertical = true
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PtyTerminalSwiftTermContentView does not support Interface Builder")
    }

    deinit {
        let driver = sessionDriver
        Task { @MainActor in
            driver?.detach()
        }
    }

    public func bind(to connection: PtyTerminalConnection) {
        precondition(sessionDriver == nil, "detach the current PTY connection before rebinding")
        bindingGeneration &+= 1
        let generation = bindingGeneration
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: self,
            onTermination: { [weak self] termination in
                self?.handleSessionTermination(termination, bindingGeneration: generation)
            }
        ) { [weak self] error in
            guard let self, self.bindingGeneration == generation, self.isBound else { return }
            self.delegate?.ptyTerminalContent(self, didFail: error)
        }
        sessionDriver = driver
        isBound = true
        driver.start()
    }

    public func detach() {
        let driver = sessionDriver
        invalidateBinding()
        sessionDriver = nil
        isBound = false
        driver?.detach()
    }

    public func stop() {
        let driver = sessionDriver
        invalidateBinding()
        sessionDriver = nil
        isBound = false
        driver?.stop()
    }

    public func focus() {
        #if canImport(AppKit)
        window?.makeFirstResponder(terminalView)
        #elseif canImport(UIKit)
        _ = terminalView.becomeFirstResponder()
        #endif
    }

    public func resignFocus() {
        #if canImport(AppKit)
        if window?.firstResponder === terminalView {
            window?.makeFirstResponder(nil)
        }
        #elseif canImport(UIKit)
        if terminalView.isFirstResponder {
            _ = terminalView.resignFirstResponder()
        }
        #endif
    }

    public func setFontSize(_ pointSize: CGFloat) {
        terminalView.font = PtyTerminalViewStyle.terminalFont(pointSize: pointSize)
        terminalView.resize(cols: columns, rows: rows)
        updateFitLayout()
        #if canImport(AppKit)
        terminalView.needsDisplay = true
        #elseif canImport(UIKit)
        terminalView.setNeedsDisplay()
        #endif
    }

    public func paste(text: String) {
        let bytes = PtyTerminalPaste.bytes(
            for: text,
            bracketed: terminalView.getTerminal().bracketedPasteMode
        )
        sessionDriver?.sendInput(Data(bytes))
    }

    public func beginCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        isSynchronizing = true
        terminalView.isHidden = true
        syncStatus.isHidden = false
        historyStatus.isHidden = true
        authoritativeDimensions = PtyTerminalDimensions(
            columns: checkpoint.columns,
            rows: checkpoint.rows
        )
        viewportOrigin = .zero
        isViewportCropped = false
        applyManagerData(Data([0x1b, 0x63]))
        terminalView.resize(cols: Int(checkpoint.columns), rows: Int(checkpoint.rows))
        terminalView.changeScrollback(2_000)
        sizeControl.update(columns: Int(checkpoint.columns), rows: Int(checkpoint.rows))
        updateFitLayout()
    }

    public func feedCheckpointChunk(_ data: Data) {
        guard isSynchronizing else { return }
        applyManagerData(data)
    }

    public func endCheckpoint(_ checkpoint: PtyTerminalCheckpoint) {
        appliedRevision = checkpoint.revision
        isSynchronizing = false
        terminalView.isHidden = false
        syncStatus.isHidden = true
        historyStatus.isHidden = !checkpoint.historyTruncated
        updateFitLayout()
        #if canImport(AppKit)
        setAccessibilityHelp(checkpoint.historyTruncated
            ? "Terminal synchronized. Older history was truncated."
            : "Terminal synchronized.")
        #else
        accessibilityHint = checkpoint.historyTruncated
            ? "Terminal synchronized. Older history was truncated."
            : "Terminal synchronized."
        #endif
    }

    public func feedOutput(_ data: Data, revision: UInt64) {
        guard !isSynchronizing else { return }
        applyManagerData(data)
        appliedRevision = revision
        updateFitLayout()
    }

    public func feedStatus(_ text: String) {
        delegate?.ptyTerminalContent(self, didReceiveStatus: text)
    }

    /// Renders a client-local diagnostic after synchronization. This is not
    /// session output and deliberately does not participate in revisions.
    public func feedLocalStatus(_ data: Data) {
        guard !isSynchronizing else { return }
        applyManagerData(data)
        updateFitLayout()
    }

    public func closeAfterManagerDetach() {
        guard isBound else { return }
        stop()
        delegate?.ptyTerminalContentDidDetachByManager(self)
    }

    func handleSessionTermination(
        _ termination: PtyTerminalSessionTermination,
        bindingGeneration: UInt64
    ) {
        guard isBound, bindingGeneration == self.bindingGeneration else { return }
        stop()
        delegate?.ptyTerminalContent(self, didTerminate: termination)
    }

    public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        // The manager owns the logical grid. Container layout only changes the
        // local fit transform and must never resize the shared PTY.
    }

    public func setTerminalTitle(source: TerminalView, title: String) {
        delegate?.ptyTerminalContent(self, didSetTitle: title)
    }

    public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    public func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard isInputEnabled, !isApplyingManagerData else { return }
        sessionDriver?.sendInput(Data(data))
    }

    public func scrolled(source: TerminalView, position: Double) {}

    public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        #if canImport(AppKit)
        NSWorkspace.shared.open(url)
        #elseif canImport(UIKit)
        UIApplication.shared.open(url)
        #endif
    }

    public func bell(source: TerminalView) {}

    public func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([text as NSString])
        #elseif canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }

    public func clipboardRead(source: TerminalView) -> Data? {
        #if canImport(AppKit)
        guard let text = NSPasteboard.general.string(forType: .string) else { return nil }
        #elseif canImport(UIKit)
        guard let text = UIPasteboard.general.string else { return nil }
        #endif
        return Data(text.utf8)
    }

    public func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
    public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    private func invalidateBinding() {
        bindingGeneration &+= 1
    }

    private func synchronizeLayout() {
        #if canImport(AppKit)
        layoutSubtreeIfNeeded()
        #elseif canImport(UIKit)
        layoutIfNeeded()
        #endif
    }

    public func applyLogicalSize(columns: Int, rows: Int) {
        guard (1...512).contains(columns), (1...256).contains(rows) else { return }
        sessionDriver?.resize(columns: columns, rows: rows)
    }

    private func applyManagerData(_ data: Data) {
        isApplyingManagerData = true
        defer { isApplyingManagerData = false }
        terminalView.feed(byteArray: [UInt8](data)[...])
    }

    private func updateFitLayout() {
        let optimal = terminalView.getOptimalFrameSize().size
        let canvasSize = CGSize(
            width: ceil(optimal.width.nextUp),
            height: ceil(optimal.height.nextUp)
        )
        let terminal = terminalView.getTerminal()
        let columns = max(terminal.cols, 1)
        let rows = max(terminal.rows, 1)
        let cellSize = CGSize(
            width: canvasSize.width / CGFloat(columns),
            height: canvasSize.height / CGFloat(rows)
        )
        let cursorLocation = terminal.getCursorLocation()
        let cursorPoint = CGPoint(
            x: (CGFloat(min(max(cursorLocation.x, 0), columns - 1)) + 0.5) * cellSize.width,
            y: cursorCanvasY(
                row: min(max(cursorLocation.y, 0), rows - 1),
                cellHeight: cellSize.height,
                canvasHeight: canvasSize.height
            )
        )
        #if canImport(AppKit)
        let initialViewportOrigin = CGPoint.zero
        #elseif canImport(UIKit)
        let initialViewportOrigin = CGPoint(x: 0, y: canvasSize.height)
        #endif
        guard let transform = PtyTerminalFitTransform(
            canvasSize: canvasSize,
            containerBounds: bounds,
            cursorPoint: cursorPoint,
            previousViewportOrigin: isViewportCropped ? viewportOrigin : nil,
            initialViewportOrigin: initialViewportOrigin,
            cursorMargin: CGSize(width: cellSize.width * 2, height: cellSize.height * 2)
        ) else { return }
        fitScale = transform.scale
        viewportOrigin = transform.viewportOrigin
        isViewportCropped = transform.isCropped
        #if canImport(AppKit)
        // SwiftTerm interprets its own frame changes as terminal resizes. Keep
        // it at the authoritative natural canvas size and scale a neutral
        // wrapper whose frame/bounds mapping also inverse-maps input points.
        canvasView.frame = transform.visualFrame
        canvasView.bounds = CGRect(origin: .zero, size: canvasSize)
        terminalView.frame = canvasView.bounds
        #elseif canImport(UIKit)
        canvasView.transform = .identity
        canvasView.bounds = CGRect(origin: .zero, size: canvasSize)
        canvasView.center = CGPoint(x: transform.visualFrame.midX, y: transform.visualFrame.midY)
        terminalView.frame = canvasView.bounds
        canvasView.transform = CGAffineTransform(scaleX: fitScale, y: fitScale)
        #endif
    }

    private func cursorCanvasY(row: Int, cellHeight: CGFloat, canvasHeight: CGFloat) -> CGFloat {
        #if canImport(AppKit)
        canvasHeight - (CGFloat(row) + 0.5) * cellHeight
        #elseif canImport(UIKit)
        (CGFloat(row) + 0.5) * cellHeight
        #endif
    }

    private func configureOverlayControls() {
        sizeControl.onApply = { [weak self] columns, rows in
            self?.applyLogicalSize(columns: columns, rows: rows)
        }
        #if canImport(AppKit)
        syncStatus.stringValue = "Synchronizing…"
        historyStatus.stringValue = "History truncated"
        syncStatus.isBezeled = false
        syncStatus.drawsBackground = false
        historyStatus.isBezeled = false
        historyStatus.drawsBackground = false
        syncStatus.setAccessibilityIdentifier("terminal-sync-status")
        historyStatus.setAccessibilityIdentifier("terminal-session-history-truncated")
        #elseif canImport(UIKit)
        syncStatus.text = "Synchronizing…"
        historyStatus.text = "History truncated"
        syncStatus.textColor = .secondaryLabel
        historyStatus.textColor = .systemOrange
        syncStatus.accessibilityIdentifier = "terminal-sync-status"
        historyStatus.accessibilityIdentifier = "terminal-session-history-truncated"
        #endif
        historyStatus.isHidden = true
        addSubview(syncStatus)
        addSubview(historyStatus)
        addSubview(sizeControl)
    }

    private func layoutOverlayControls() {
        let margin: CGFloat = 8
        let size = CGSize(width: 96, height: 28)
        sizeControl.isHidden = bounds.width < size.width + margin * 2
            || bounds.height < size.height + margin * 2
        sizeControl.frame = CGRect(
            x: max(margin, bounds.width - size.width - margin),
            y: margin,
            width: size.width,
            height: size.height
        )
        syncStatus.frame = CGRect(x: margin, y: margin, width: 160, height: 24)
        historyStatus.frame = CGRect(x: margin, y: margin, width: 160, height: 24)
    }

    #if canImport(AppKit)
    public override func layout() {
        super.layout()
        updateFitLayout()
        layoutOverlayControls()
    }
    #elseif canImport(UIKit)
    public override func layoutSubviews() {
        super.layoutSubviews()
        updateFitLayout()
        layoutOverlayControls()
    }
    #endif

    #if canImport(AppKit)
    public override func accessibilityPerformPress() -> Bool {
        focus()
        return true
    }
    #endif
}
