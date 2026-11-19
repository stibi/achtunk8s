import AchtungDomain
import SwiftUI

/// One row of the command palette (⌘P): a channel or page to go to, or something to do.
/// The window says which there are right now (`InboxView.paletteCommands`); the palette
/// only lists, filters and runs them.
struct PaletteCommand: Identifiable {
    /// The headings of the list before anything is typed, in its order.
    enum Group: String, CaseIterable {
        case recent = "Recent"
        case page = "Go to"
        case action = "Commands"
        case channel = "Channels"
    }

    enum Action {
        /// Done at once, and can't fail.
        case run(@MainActor () -> Void)
        /// Done at once. Returns what to tell the user when it didn't work out.
        case attempt(@MainActor () async -> String?)
        /// Asks one more thing in the palette first, e.g. how long to silence for.
        case choose(prompt: String, from: [PaletteCommand])
    }

    let id: String
    let title: String
    /// Beside the title in grey, and matched like it: a channel's instance, the alert a
    /// command is about.
    var detail: String?
    let group: Group
    let systemImage: String
    /// The catalogue's shortcut of the control that does the same, to show beside it; the
    /// key itself stays that control's.
    var shortcut: Shortcut?
    /// A channel's unread occurrences, and the critical ones among them, as in the sidebar.
    var unread = 0
    var unreadCritical = 0
    /// Why it can't run right now; nil when it can.
    var unavailable: String?
    let action: Action

    /// What typing is matched against (`FuzzyMatch`).
    var searchText: String {
        detail.map { "\(title) \($0)" } ?? title
    }
}

/// Opens the command palette of the window in front, or closes it.
struct ToggleCommandPaletteAction {
    let toggle: () -> Void

    func callAsFunction() {
        toggle()
    }
}

extension FocusedValues {
    /// Nil while no window with a palette is in front.
    @Entry var toggleCommandPalette: ToggleCommandPaletteAction?
}

/// The palette's menu item, in the View menu. ⌘P (`Shortcut.commandPalette`) is Print in
/// apps that print; Achtung doesn't.
struct CommandPaletteCommands: Commands {
    @FocusedValue(\.toggleCommandPalette) private var toggle
    /// The shortcuts help is modal: nothing opens behind it.
    @FocusedBinding(\.shortcutsHelpShown) private var showsShortcutsHelp

    var body: some Commands {
        CommandGroup(before: .toolbar) {
            Button("Command Palette…") { toggle?() }
                .shortcut(.commandPalette)
                .disabled(toggle == nil || showsShortcutsHelp == true)
        }
    }
}
