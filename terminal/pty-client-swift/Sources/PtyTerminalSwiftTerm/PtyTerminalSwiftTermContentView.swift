import Foundation
import PtyTerminalSession
import SwiftTerm

#if canImport(AppKit)
import AppKit
public typealias PtyTerminalContentPlatformView = NSView
#elseif canImport(UIKit)
import UIKit
public typealias PtyTerminalContentPlatformView = UIView
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
    public var isInputEnabled = true
    public private(set) var isBound = false
    public private(set) var rendererSetupError: Error?
    private(set) var bindingGeneration: UInt64 = 0

    public var columns: Int { terminalView.getTerminal().cols }
    public var rows: Int { terminalView.getTerminal().rows }

    private var sessionDriver: PtyTerminalSessionDriver?

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
        super.init(frame: .zero)

        do {
            try style.apply(to: nativeView)
        } catch {
            rendererSetupError = error
        }
        nativeView.translatesAutoresizingMaskIntoConstraints = false
        nativeView.terminalDelegate = self
        #if canImport(AppKit)
        nativeView.pasteHandler = { [weak self] text in self?.paste(text: text) }
        #endif
        addSubview(nativeView)
        NSLayoutConstraint.activate([
            nativeView.leadingAnchor.constraint(equalTo: leadingAnchor),
            nativeView.trailingAnchor.constraint(equalTo: trailingAnchor),
            nativeView.topAnchor.constraint(equalTo: topAnchor),
            nativeView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

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

    public func feedOutput(_ data: Data) {
        terminalView.feed(byteArray: [UInt8](data)[...])
    }

    public func feedStatus(_ text: String) {
        delegate?.ptyTerminalContent(self, didReceiveStatus: text)
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
        sessionDriver?.resize(columns: newCols, rows: newRows)
    }

    public func setTerminalTitle(source: TerminalView, title: String) {
        delegate?.ptyTerminalContent(self, didSetTitle: title)
    }

    public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    public func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard isInputEnabled else { return }
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
}
