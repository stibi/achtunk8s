import AchtungDomain
import AppKit
import SwiftUI

extension FocusedValues {
    /// Whether the main window shows its shortcuts help; nil when another window is in front.
    @Entry var shortcutsHelpShown: Binding<Bool>?
}

/// The Help menu's "Keyboard Shortcuts", in place of the help book Achtung doesn't have.
struct ShortcutsHelpCommands: Commands {
    @FocusedBinding(\.shortcutsHelpShown) private var isShown

    var body: some Commands {
        CommandGroup(replacing: .help) {
            Button("Keyboard Shortcuts") { isShown?.toggle() }
                .shortcut(.help)
                .disabled(isShown == nil)
        }
    }
}

extension View {
    /// Lets ⌥? and the Help menu show the keyboard shortcuts over this window's content.
    func shortcutsHelp() -> some View {
        modifier(ShortcutsHelpPresenter())
    }
}

/// Shows the help over the window's content and makes it modal: while it's open, the
/// window behind takes no keys and no clicks, and what had the focus keeps it, so closing
/// the help returns there.
private struct ShortcutsHelpPresenter: ViewModifier {
    @State private var isShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .accessibilityHidden(isShown)
            .overlay {
                if isShown {
                    ShortcutsHelp { isShown = false }
                        .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: isShown)
            .background(ShortcutsHelpEvents(isShown: $isShown))
            .focusedSceneValue(\.shortcutsHelpShown, $isShown)
            // A window closed with the help open comes back without it.
            .onDisappear { isShown = false }
    }
}

/// The shortcuts by group on a panel in the middle of a dimmed window. A click beside the
/// panel closes it, as do its close button, Esc and ⌥? (`ShortcutsHelpEvents`).
private struct ShortcutsHelp: View {
    let close: () -> Void

    /// The groups in two columns of about as many shortcuts each.
    private static let columns: [[Shortcut.Group]] = {
        var left: [Shortcut.Group] = []
        var right: [Shortcut.Group] = []
        var rows = 0
        for group in Shortcut.Group.allCases {
            rows += group.shortcuts.count
            if right.isEmpty, rows * 2 <= Shortcut.allCases.count + 1 {
                left.append(group)
            } else {
                right.append(group)
            }
        }
        return [left, right]
    }()

    var body: some View {
        ZStack {
            Color.black.opacity(0.3)
                .ignoresSafeArea()
                .contentShape(.rect)
                .onTapGesture(perform: close)
                .accessibilityHidden(true)
            panel
                .padding(24)
        }
    }

    private var panel: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Keyboard Shortcuts")
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button(action: close) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Close (\(Shortcut.back.symbols))")
                .accessibilityLabel("Close")
            }
            // Scrolls only in a window too short for it.
            ViewThatFits(in: .vertical) {
                groups
                ScrollView { groups }
            }
        }
        .padding(22)
        .frame(width: 700)
        .background(.regularMaterial, in: shape)
        .overlay { shape.strokeBorder(.separator, lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
        // Swallows clicks on the panel, which would otherwise reach the backdrop.
        .contentShape(shape)
        .onTapGesture {}
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Keyboard Shortcuts")
        .accessibilityAddTraits(.isModal)
    }

    private var groups: some View {
        HStack(alignment: .top, spacing: 32) {
            ForEach(Self.columns, id: \.self) { column in
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(column) { group in
                        section(group)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func section(_ group: Shortcut.Group) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(group.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            ForEach(group.shortcuts) { shortcut in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(shortcut.title)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    HStack(spacing: 3) {
                        ForEach(shortcut.keyLabels, id: \.self) { label in
                            Keycap(label: label)
                        }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(shortcut.title), \(shortcut.spokenKeys)")
            }
        }
    }
}

/// One key of a shortcut, drawn as a key.
private struct Keycap: View {
    let label: String

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
        Text(label)
            .font(.system(.callout, design: .rounded).weight(.medium))
            .padding(.horizontal, 5)
            .frame(minWidth: 24, minHeight: 22)
            .background(.quaternary, in: shape)
            .overlay { shape.strokeBorder(.separator, lineWidth: 0.5) }
    }
}

#Preview {
    ShortcutsHelp {}
        .frame(width: 900, height: 600)
}
