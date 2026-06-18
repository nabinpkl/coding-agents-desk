import UIKit

// R12.3 keyboard surface wiring. The KeyboardSurface view is a hidden
// first-responder that backs the iOS soft keyboard; this extension owns
// the tap-to-dismiss recognizer, the button-row constraint animation
// that lifts the row above the keyboard, and the show/hide toggle that
// switches the trackpad in and out of view while typing.

extension PairingViewController: UIGestureRecognizerDelegate, KeyboardSurfaceDelegate {
    func configureKeyboardSurface() {
        keyboardSurface.keyboardDelegate = self
        keyboardSurface.translatesAutoresizingMaskIntoConstraints = false
        // Sits just above the bottom button row so the user sees what
        // they typed locally as confirmation while wire events go to
        // the Mac. Hidden until the user summons it.
        keyboardSurface.isHidden = true
        view.addSubview(keyboardSurface)
        // R23: leading/trailing are orientation-variant and live in the
        // portrait/landscape arrays built by showTrackpad. Height and
        // bottom (relative to buttonRow.topAnchor) stay shared.
        NSLayoutConstraint.activate([
            keyboardSurface.heightAnchor.constraint(equalToConstant: 36)
        ])
        // Any tap on the app's main view dismisses the keyboard.
        // cancelsTouchesInView=false so button taps and trackpad
        // gestures still reach their own handlers.
        //
        // delaysTouchesEnded defaults to true on UITapGestureRecognizer,
        // which would hold back the trackpad pan's touchesEnded by
        // ~150ms (the iOS tap timeout) waiting to confirm this isn't a
        // tap. Force both delay flags off so the pan path is never
        // blocked by tap arbitration.
        //
        // gestureRecognizerShouldBegin further restricts the tap to
        // fire only when the keyboard is up.
        let dismissTap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboardIfShown))
        dismissTap.cancelsTouchesInView = false
        dismissTap.delaysTouchesBegan = false
        dismissTap.delaysTouchesEnded = false
        dismissTap.delegate = self
        view.addGestureRecognizer(dismissTap)
        dismissKeyboardTap = dismissTap
    }

    // MARK: - UIGestureRecognizerDelegate

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === dismissKeyboardTap {
            return keyboardSurface.isFirstResponder
        }
        return true
    }

    @objc func dismissKeyboardIfShown() {
        if keyboardSurface.isFirstResponder {
            toggleKeyboard()
        }
    }

    @objc func toggleKeyboard() {
        if keyboardSurface.isFirstResponder {
            keyboardSurface.setVisible(false)
            keyboardSurface.isHidden = true
            keyboardSurface.text = ""
            setTrackpadHidden(false)
            refreshInputSurfaceMode()
            showKeyboardButton.setTitle("Show keyboard", for: .normal)
        } else {
            keyboardSurface.isHidden = false
            setTrackpadHidden(true)
            keyboardSurface.setVisible(true)
            refreshInputSurfaceMode()
            showKeyboardButton.setTitle("Hide keyboard", for: .normal)
        }
    }

    // Trackpad and scroll-strip serve no purpose while the keyboard is
    // up (the user is typing, not pointing). Leaving them visible
    // caused the trackpad's "Trackpad" hint and the scroll strip's
    // chevron to bleed through behind the text-echo field.
    func setTrackpadHidden(_ hidden: Bool) {
        trackpadView.isHidden = hidden
        scrollStripView.isHidden = hidden
        screenTrackpadOverlay.isHidden = hidden || SettingsStore.shared.inputSurfaceMode != .screenTrackpad
        screenTrackpadOverlay.isUserInteractionEnabled = !screenTrackpadOverlay.isHidden
        if hidden {
            thumbnailStripView.isHidden = true
        } else {
            refreshThumbnailStripVisibility()
        }
    }

    @objc func keyboardWillChangeFrame(_ note: Notification) {
        guard
            let endFrame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
            buttonRowBottomConstraint != nil
        else { return }
        // Convert from screen coords to view coords so multi-window /
        // split-view setups don't double-count safe area. overlap is
        // the y-distance the keyboard hides from the bottom of our
        // view.
        let endInView = view.convert(endFrame, from: nil)
        let overlap = max(0, view.bounds.maxY - endInView.minY)
        let safeBottom = view.safeAreaInsets.bottom
        // The safe-area anchor already accounts for safeBottom, so add
        // only the extra that the keyboard hides on top of it.
        let extra = max(0, overlap - safeBottom)
        animateButtonRow(to: -(extra + 12), with: note)
    }

    @objc func keyboardWillHide(_ note: Notification) {
        animateButtonRow(to: -12, with: note)
    }

    private func animateButtonRow(to constant: CGFloat, with note: Notification) {
        guard let bottom = buttonRowBottomConstraint else { return }
        bottom.constant = constant
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? TimeInterval) ?? 0.25
        UIView.animate(withDuration: duration) {
            self.view.layoutIfNeeded()
        }
    }

    // MARK: - KeyboardSurfaceDelegate

    func keyboardSurface(_ surface: KeyboardSurface, didProduce input: NormalizedInput) {
        sendInput(input)
    }
}
