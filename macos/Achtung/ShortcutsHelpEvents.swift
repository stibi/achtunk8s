import AchtungDomain
import AppKit
import SwiftUI

/// The keys and clicks of the window it sits in, for the shortcuts help. ⌥? opens and
/// closes it from anywhere in the window. While it's open, Esc closes it, the App group's
/// shortcuts (Settings, close, quit) still work, and every other key stops here, so no
/// shortcut acts behind it. A click on the title bar or the toolbar, which the help's
/// backdrop doesn't cover, closes it instead of pressing what is there, and so does a
/// right click anywhere, before it opens a menu of what is behind.
///
/// It watches events rather than using a menu item's key equivalent because a key without
/// ⌘ goes to the focused view first: in the search field ⌥? would type "¿", and a list
/// would take it for type-to-select.
struct ShortcutsHelpEvents: NSViewRepresentable {
    @Binding var isShown: Bool

    func makeNSView(context: Context) -> WindowEvents {
        WindowEvents()
    }

    func updateNSView(_ view: WindowEvents, context: Context) {
        view.isShown = $isShown
    }

    static func dismantleNSView(_ view: WindowEvents, coordinator: ()) {
        view.stopWatching()
    }

    final class WindowEvents: NSView {
        var isShown = Binding.constant(false)
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            stopWatching()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(
                matching: [.keyDown, .leftMouseDown, .rightMouseDown]
            ) { [weak self] event in
                // What the event says, taken out of it so it can cross to the main actor.
                let input: Input =
                    switch event.type {
                    case .keyDown: .key(KeyDown(event))
                    case .rightMouseDown: .rightClick
                    default: .click(event.locationInWindow)
                    }
                let windowNumber = event.windowNumber
                let taken = MainActor.assumeIsolated {
                    self?.takes(input, inWindow: windowNumber) ?? false
                }
                return taken ? nil : event
            }
        }

        func stopWatching() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
            monitor = nil
        }

        /// Whether the help keeps an event of this view's window from going any further.
        private func takes(_ input: Input, inWindow number: Int) -> Bool {
            guard let window, window.windowNumber == number else { return false }
            let isOpen = isShown.wrappedValue
            switch input {
            case .click(let location):
                // The backdrop takes the clicks on the content.
                guard isOpen, location.y > window.contentLayoutRect.maxY else { return false }
            case .rightClick:
                guard isOpen else { return false }
            case .key(let keyDown):
                if keyDown.is(.help) {
                    // Holding the keys down toggles once, not with every repeat.
                    if !keyDown.isRepeat {
                        isShown.wrappedValue.toggle()
                    }
                    return true
                }
                guard isOpen else { return false }
                guard keyDown.is(.back) else {
                    return !Shortcut.Group.app.shortcuts.contains(where: keyDown.is)
                }
            }
            isShown.wrappedValue = false
            return true
        }
    }
}

private enum Input: Sendable {
    case key(KeyDown)
    case click(CGPoint)
    case rightClick
}

private struct KeyDown: Sendable {
    let characters: String
    let held: Set<Shortcut.Modifier>
    let isRepeat: Bool

    init(_ event: NSEvent) {
        characters = event.charactersIgnoringModifiers ?? ""
        var held: Set<Shortcut.Modifier> = []
        if event.modifierFlags.contains(.control) { held.insert(.control) }
        if event.modifierFlags.contains(.option) { held.insert(.option) }
        if event.modifierFlags.contains(.shift) { held.insert(.shift) }
        if event.modifierFlags.contains(.command) { held.insert(.command) }
        self.held = held
        isRepeat = event.isARepeat
    }

    func `is`(_ shortcut: Shortcut) -> Bool {
        shortcut.matches(characters: characters, held: held)
    }
}
