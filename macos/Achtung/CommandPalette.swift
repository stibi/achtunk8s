import AchtungDomain
import SwiftUI

/// The command palette over the window (⌘P, or View › Command Palette…): a field and a
/// list of channels, pages and commands, for working without the mouse. Esc, ⌘P again or
/// a click anywhere else closes it. What a command couldn't do is said in an alert.
struct CommandPaletteHost: ViewModifier {
    /// The window's commands right now, asked for only while the palette is open.
    let commands: () -> [PaletteCommand]

    @State private var isShown = false
    @Environment(\.openSettings) private var openSettings
    @Environment(UpdateController.self) private var updates
    @FocusedBinding(\.shortcutsHelpShown) private var showsShortcutsHelp
    @State private var failure: (title: String, message: String)?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if isShown {
                    ZStack(alignment: .top) {
                        Color.clear
                            .contentShape(.rect)
                            .onTapGesture { isShown = false }
                            .accessibilityHidden(true)
                        CommandPalette(commands: grouped(commands() + appCommands)) {
                            isShown = false
                        } failed: { title, message in
                            failure = (title, message)
                        }
                        .padding(.top, 48)
                        .padding(.horizontal, 16)
                    }
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.12), value: isShown)
            .focusedSceneValue(
                \.toggleCommandPalette, ToggleCommandPaletteAction { isShown.toggle() }
            )
            .alert(
                failure?.title ?? "",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }),
                actions: { Button("OK") { failure = nil } },
                message: { Text(failure?.message ?? "") })
    }
}

extension CommandPaletteHost {
    /// What every window's palette has: the app's own commands, as its menus have them.
    private var appCommands: [PaletteCommand] {
        var result = [
            PaletteCommand(
                id: "settings", title: "Open Settings", group: .action,
                systemImage: "gearshape", shortcut: .settings, action: .run { openSettings() }),
            PaletteCommand(
                id: "check-for-updates", title: "Check for Updates…", group: .action,
                systemImage: "arrow.down.circle",
                unavailable: updates.canCheck
                    ? nil : updates.availability.reason ?? "Not in this copy",
                action: .run { updates.checkForUpdates() }),
        ]
        if showsShortcutsHelp != nil {
            result.append(
                PaletteCommand(
                    id: "shortcuts-help", title: "Keyboard Shortcuts", group: .action,
                    systemImage: "keyboard", shortcut: .help,
                    action: .run { showsShortcutsHelp = true }))
        }
        return result
    }

    /// Each group's commands together, in the groups' order, as the headings need them.
    private func grouped(_ commands: [PaletteCommand]) -> [PaletteCommand] {
        PaletteCommand.Group.allCases.flatMap { group in commands.filter { $0.group == group } }
    }
}

/// The palette itself. Typing filters and ranks the commands (`FuzzyMatch`), ↑ and ↓ or
/// ⌃P and ⌃N move the selection, which starts on the first row, and Return runs it.
private struct CommandPalette: View {
    let commands: [PaletteCommand]
    let close: () -> Void
    /// A command's title and what it said when it didn't work out.
    let failed: (String, String) -> Void

    /// A key pressed, and held down.
    private static let held: KeyPress.Phases = [.down, .repeat]

    @State private var query = ""
    /// Nil for the first row, as after every change of the query.
    @State private var selectedID: PaletteCommand.ID?
    /// A command's question and its answers, shown in place of the commands.
    @State private var question: (prompt: String, choices: [PaletteCommand])?
    @FocusState private var isFocused: Bool

    private var rows: [(item: PaletteCommand, match: FuzzyMatch)] {
        FuzzyMatch.ranked(question?.choices ?? commands, by: query) { $0.searchText }
    }

    var body: some View {
        let rows = self.rows
        let selected = selected(in: rows)
        VStack(spacing: 0) {
            field
            Divider()
            if rows.isEmpty {
                Text("Nothing matches “\(query)”")
                    .foregroundStyle(.secondary)
                    .padding(16)
            } else {
                PaletteRows(
                    rows: rows, selectedID: selected?.id,
                    // Headings only before anything is typed; after that the best match
                    // is first, whatever it is.
                    showsGroups: question == nil && query.allSatisfy(\.isWhitespace), run: run)
            }
        }
        .frame(width: 560)
        .background(.regularMaterial, in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12).strokeBorder(.separator)
        }
        .shadow(color: .black.opacity(0.25), radius: 24, y: 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Command palette")
        .accessibilityAddTraits(.isModal)
        // The field can't take the focus as it appears, only a moment later (about a tenth
        // of a second on macOS 27), so it's asked until it has it. Without it, typing would
        // go to the list that had the focus, e.g. the sidebar.
        .task {
            while !isFocused, !Task.isCancelled {
                isFocused = true
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
        // A click on the toolbar or in another window, which the overlay doesn't cover.
        .onChange(of: isFocused) {
            if !isFocused {
                close()
            }
        }
        .onChange(of: query) { selectedID = nil }
        // VoiceOver stays in the field, so it's told where the selection went.
        .onChange(of: selected?.id) {
            if let selected {
                AccessibilityNotification.Announcement(selected.accessibilityLabel).post()
            }
        }
    }

    /// The selected row, or the first one. The field's keys ask for it as they are pressed:
    /// what a closure took from the last update was a row behind on Return.
    private func selected(
        in rows: [(item: PaletteCommand, match: FuzzyMatch)]
    ) -> PaletteCommand? {
        rows.first { $0.item.id == selectedID }?.item ?? rows.first?.item
    }

    private var field: some View {
        HStack(spacing: 10) {
            Image(systemName: question == nil ? "magnifyingglass" : "chevron.right")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(question?.prompt ?? "Go to a channel or run a command", text: $query)
                .textFieldStyle(.plain)
                .focused($isFocused)
                .onSubmit {
                    if let selected = selected(in: rows) {
                        run(selected)
                    }
                }
                .onKeyPress(Shortcut.selectNext.keyEquivalent) {
                    move(1)
                }
                .onKeyPress(Shortcut.selectPrevious.keyEquivalent) {
                    move(-1)
                }
                .onKeyPress(Shortcut.paletteNext.keyEquivalent, phases: Self.held) {
                    $0.modifiers.subtracting(.capsLock) == .control ? move(1) : .ignored
                }
                .onKeyPress(Shortcut.palettePrevious.keyEquivalent, phases: Self.held) {
                    $0.modifiers.subtracting(.capsLock) == .control ? move(-1) : .ignored
                }
                .onExitCommand(perform: back)
        }
        .font(.title3)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func move(_ step: Int) -> KeyPress.Result {
        let rows = self.rows
        if let index = rows.firstIndex(where: { $0.item.id == selected(in: rows)?.id }) {
            selectedID = rows[min(max(index + step, 0), rows.count - 1)].item.id
        }
        return .handled
    }

    /// Esc leaves a command's question for the commands, and the commands for the window.
    private func back() {
        if question == nil {
            close()
        } else {
            question = nil
            query = ""
        }
    }

    private func run(_ command: PaletteCommand) {
        guard command.unavailable == nil else { return }
        switch command.action {
        case .run(let action):
            close()
            action()
        case .attempt(let action):
            close()
            Task {
                if let message = await action() {
                    failed(command.title, message)
                }
            }
        case .choose(let prompt, let choices):
            question = (prompt, choices)
            query = ""
            selectedID = nil
        }
    }
}
