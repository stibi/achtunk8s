import AchtungDomain
import SwiftUI

// The catalogue's shortcuts (`Shortcut` in AchtungDomain) as SwiftUI has them.
// Controls take their keys through `shortcut(_:)`, never with a `keyboardShortcut` of
// their own (SwiftLint's `shortcuts_from_the_catalogue`; `onKeyPress` takes a
// `keyEquivalent` from here too), so the help lists them all.

extension Shortcut {
    var keyEquivalent: KeyEquivalent {
        switch key {
        case .character(let character): KeyEquivalent(character)
        case .escape: .escape
        case .return: .return
        case .space: .space
        case .upArrow: .upArrow
        case .downArrow: .downArrow
        }
    }

    /// The help's "?" stays "?" on every keyboard layout, as the help's own events take it
    /// (`ShortcutsHelpEvents`); SwiftUI would put the character of the US "?" key's place
    /// there, "⌥ˇ" on a Czech keyboard.
    var keyboardShortcut: KeyboardShortcut {
        KeyboardShortcut(
            keyEquivalent, modifiers: eventModifiers,
            localization: self == .help ? .custom : .automatic)
    }

    private var eventModifiers: EventModifiers {
        var result: EventModifiers = []
        if modifiers.contains(.control) { result.insert(.control) }
        if modifiers.contains(.option) { result.insert(.option) }
        if modifiers.contains(.shift) { result.insert(.shift) }
        if modifiers.contains(.command) { result.insert(.command) }
        return result
    }
}

extension View {
    /// Gives a control its shortcut from the catalogue; with `isActive` false, none.
    func shortcut(_ shortcut: Shortcut, isActive: Bool = true) -> some View {
        keyboardShortcut(isActive ? shortcut.keyboardShortcut : nil)
    }
}
