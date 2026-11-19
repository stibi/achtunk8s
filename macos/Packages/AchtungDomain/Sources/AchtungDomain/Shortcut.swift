/// Every keyboard shortcut of the main window and the menu bar menu, defined once: the
/// controls take their keys from here (`shortcut(_:)` in the app) and the help overlay
/// (⌥?) lists all of them, so a shortcut can't be missing from the help (SwiftLint keeps
/// `keyboardShortcut` and `onKeyPress` in the app to keys from here).
///
/// The arrows in a list and closing the window are macOS's own behaviour; they are listed
/// because people look for them. Live and the command palette bind their arrows from here.
public enum Shortcut: String, Sendable, CaseIterable, Identifiable {
    case selectPrevious, selectNext, open, toggleCard, back
    case commandPalette, paletteNext, palettePrevious
    case search
    case refresh, markAllRead, copyForAgent, remindMe
    case help, settings, closeWindow, quit

    /// The help's sections, in its order.
    public enum Group: String, Sendable, CaseIterable, Identifiable {
        case navigation = "Navigation"
        case palette = "Command Palette"
        case search = "Search"
        case alerts = "Alerts"
        case app = "App"

        public var id: String { rawValue }
        public var title: String { rawValue }

        public var shortcuts: [Shortcut] { Shortcut.allCases.filter { $0.group == self } }
    }

    public enum Key: Hashable, Sendable {
        /// A key by the character it types, lowercase for a letter.
        case character(Character)
        case escape, `return`, space, upArrow, downArrow

        /// What the key types, as a key press reports it.
        var characters: String {
            switch self {
            case .character(let character): String(character)
            case .escape: "\u{1B}"
            case .return: "\r"
            case .space: " "
            case .upArrow: "\u{F700}"
            case .downArrow: "\u{F701}"
            }
        }

        var symbol: String {
            switch self {
            case .character(let character): character.uppercased()
            case .escape: "esc"
            case .return: "↩"
            case .space: "space"
            case .upArrow: "↑"
            case .downArrow: "↓"
            }
        }

        var name: String {
            switch self {
            case .character("?"): "Question Mark"
            case .character(","): "Comma"
            case .character(let character): character.uppercased()
            case .escape: "Escape"
            case .return: "Return"
            case .space: "Space"
            case .upArrow: "Up Arrow"
            case .downArrow: "Down Arrow"
            }
        }
    }

    /// In the order macOS writes them: ⌃⌥⇧⌘.
    public enum Modifier: Sendable, CaseIterable {
        case control, option, shift, command

        var symbol: String {
            switch self {
            case .control: "⌃"
            case .option: "⌥"
            case .shift: "⇧"
            case .command: "⌘"
            }
        }

        var name: String {
            switch self {
            case .control: "Control"
            case .option: "Option"
            case .shift: "Shift"
            case .command: "Command"
            }
        }
    }

    public var id: String { rawValue }

    public var key: Key {
        switch self {
        case .selectPrevious: .upArrow
        case .selectNext: .downArrow
        case .open: .return
        case .toggleCard: .space
        case .back: .escape
        case .commandPalette, .palettePrevious: .character("p")
        case .paletteNext: .character("n")
        case .refresh: .character("r")
        case .markAllRead: .character("k")
        case .copyForAgent: .character("c")
        case .remindMe: .character("r")
        case .search: .character("f")
        // The key that types "?", wherever the keyboard layout has it; Shift is part of
        // typing it, not of the shortcut.
        case .help: .character("?")
        case .settings: .character(",")
        case .closeWindow: .character("w")
        case .quit: .character("q")
        }
    }

    public var modifiers: Set<Modifier> {
        switch self {
        case .selectPrevious, .selectNext, .open, .toggleCard, .back: []
        case .refresh, .search, .settings, .closeWindow, .quit, .commandPalette: [.command]
        case .paletteNext, .palettePrevious: [.control]
        case .markAllRead, .copyForAgent, .remindMe: [.shift, .command]
        case .help: [.option]
        }
    }

    /// What it does, as the help says it.
    public var title: String {
        switch self {
        case .selectPrevious: "Select the alert above, or the palette's row"
        case .selectNext: "Select the alert below, or the palette's row"
        case .open: "Open the selected search result or Live card, or run the palette's row"
        case .toggleCard: "Open or close the selected Live card"
        case .back:
            "Go back: Home from an Alertmanager, the latest in Live, out of a search, the "
                + "palette or this help"
        case .commandPalette: "Open or close the command palette: go to a channel, run a command"
        case .paletteNext: "Select the palette's row below, like ↓"
        case .palettePrevious: "Select the palette's row above, like ↑"
        case .refresh: "Refresh Home or an Alertmanager"
        case .markAllRead: "Mark the list's alerts as read"
        case .copyForAgent: "Copy the open alert for an agent"
        case .remindMe: "Remind me about the open alert"
        case .search: "Search alerts"
        case .help: "Show or hide these keyboard shortcuts"
        case .settings: "Open Settings"
        case .closeWindow: "Close the window; Achtung stays in the menu bar"
        case .quit: "Quit Achtung"
        }
    }

    public var group: Group {
        switch self {
        case .selectPrevious, .selectNext, .open, .toggleCard, .back: .navigation
        case .commandPalette, .paletteNext, .palettePrevious: .palette
        case .search: .search
        case .refresh, .markAllRead, .copyForAgent, .remindMe: .alerts
        case .help, .settings, .closeWindow, .quit: .app
        }
    }

    /// One label per key to press, modifiers first: "⇧", "⌘", "K".
    public var keyLabels: [String] {
        Modifier.allCases.filter(modifiers.contains).map(\.symbol) + [key.symbol]
    }

    /// As menus and tooltips write it: "⇧⌘K".
    public var symbols: String { keyLabels.joined() }

    /// Whether a key press is this shortcut. `characters` is what the key types with Shift
    /// alone (AppKit's `charactersIgnoringModifiers`), so a shortcut follows its character
    /// across keyboard layouts: "?" is ⇧/ on a US keyboard and ⇧, on a Czech one. So for a
    /// character that isn't a letter, Shift may be part of typing it and doesn't count,
    /// unless the shortcut asks for it.
    public func matches(characters: String, held: Set<Modifier>) -> Bool {
        var held = held
        if case .character(let character) = key, !character.isLetter,
            !modifiers.contains(.shift)
        {
            held.remove(.shift)
        }
        return held == modifiers && characters.lowercased() == key.characters
    }

    /// For VoiceOver: "Shift Command K".
    public var spokenKeys: String {
        (Modifier.allCases.filter(modifiers.contains).map(\.name) + [key.name])
            .joined(separator: " ")
    }
}
