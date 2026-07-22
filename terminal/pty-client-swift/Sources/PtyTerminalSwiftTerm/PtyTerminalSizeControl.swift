import Foundation

#if canImport(AppKit)
import AppKit

@MainActor
final class PtyTerminalSizeControl: NSButton {
    var onApply: ((Int, Int) -> Void)?
    private var columns = 80
    private var rows = 24
    private var popover: NSPopover?

    init() {
        super.init(frame: .zero)
        bezelStyle = .rounded
        controlSize = .small
        target = self
        action = #selector(showSizePopover)
        setAccessibilityIdentifier("terminal-session-size")
        update(columns: columns, rows: rows)
    }

    required init?(coder: NSCoder) { nil }

    func update(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
        title = "\(columns) × \(rows)"
        setAccessibilityLabel("Terminal session size \(columns) columns by \(rows) rows")
    }

    @objc private func showSizePopover() {
        let controller = NSViewController()
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 250, height: 112))
        let columnsField = NSTextField(string: String(columns))
        let rowsField = NSTextField(string: String(rows))
        let apply = NSButton(title: "Apply", target: nil, action: nil)
        columnsField.setAccessibilityIdentifier("terminal-session-columns")
        rowsField.setAccessibilityIdentifier("terminal-session-rows")
        apply.setAccessibilityIdentifier("terminal-session-resize-apply")
        columnsField.placeholderString = "Columns (1–512)"
        rowsField.placeholderString = "Rows (1–256)"
        for field in [columnsField, rowsField] {
            field.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(field)
        }
        apply.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(apply)
        NSLayoutConstraint.activate([
            columnsField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            columnsField.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            columnsField.widthAnchor.constraint(equalToConstant: 108),
            rowsField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            rowsField.topAnchor.constraint(equalTo: columnsField.topAnchor),
            rowsField.widthAnchor.constraint(equalToConstant: 108),
            apply.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            apply.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
        ])
        let action = SizeApplyAction { [weak self, weak columnsField, weak rowsField] in
            guard let self,
                  let columns = Int(columnsField?.stringValue ?? ""),
                  let rows = Int(rowsField?.stringValue ?? ""),
                  (1...512).contains(columns),
                  (1...256).contains(rows) else {
                NSSound.beep()
                return
            }
            self.onApply?(columns, rows)
            self.popover?.close()
        }
        apply.target = action
        apply.action = #selector(SizeApplyAction.apply)
        objc_setAssociatedObject(apply, &SizeApplyAction.associationKey, action, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        controller.view = view
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = controller
        self.popover = popover
        popover.show(relativeTo: bounds, of: self, preferredEdge: .maxY)
    }
}

private final class SizeApplyAction: NSObject {
    static var associationKey: UInt8 = 0
    private let handler: () -> Void
    init(handler: @escaping () -> Void) { self.handler = handler }
    @objc func apply() { handler() }
}

#elseif canImport(UIKit)
import UIKit

@MainActor
final class PtyTerminalSizeControl: UIButton {
    var onApply: ((Int, Int) -> Void)?
    private var columns = 80
    private var rows = 24

    init() {
        super.init(frame: .zero)
        configuration = .tinted()
        accessibilityIdentifier = "terminal-session-size"
        addTarget(self, action: #selector(showSizeSheet), for: .touchUpInside)
        update(columns: columns, rows: rows)
    }

    required init?(coder: NSCoder) { nil }

    func update(columns: Int, rows: Int) {
        self.columns = columns
        self.rows = rows
        configuration?.title = "\(columns) × \(rows)"
        accessibilityLabel = "Terminal session size \(columns) columns by \(rows) rows"
    }

    @objc private func showSizeSheet() {
        guard let controller = nearestViewController else { return }
        let alert = UIAlertController(title: "Terminal Size", message: nil, preferredStyle: .alert)
        alert.addTextField {
            $0.text = String(self.columns)
            $0.keyboardType = .numberPad
            $0.accessibilityIdentifier = "terminal-session-columns"
        }
        alert.addTextField {
            $0.text = String(self.rows)
            $0.keyboardType = .numberPad
            $0.accessibilityIdentifier = "terminal-session-rows"
        }
        let apply = UIAlertAction(title: "Apply", style: .default) { [weak self, weak alert] _ in
            guard let self,
                  let fields = alert?.textFields,
                  fields.count == 2,
                  let columns = Int(fields[0].text ?? ""),
                  let rows = Int(fields[1].text ?? ""),
                  (1...512).contains(columns),
                  (1...256).contains(rows) else { return }
            self.onApply?(columns, rows)
        }
        apply.accessibilityIdentifier = "terminal-session-resize-apply"
        alert.addAction(apply)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let popover = alert.popoverPresentationController {
            popover.sourceView = self
            popover.sourceRect = bounds
        }
        controller.present(alert, animated: true)
    }

    private var nearestViewController: UIViewController? {
        sequence(first: next, next: { $0?.next }).first { $0 is UIViewController } as? UIViewController
    }
}
#endif
