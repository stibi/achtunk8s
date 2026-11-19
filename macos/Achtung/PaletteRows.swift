import AchtungDomain
import SwiftUI

/// The list: as tall as its rows up to a limit, past which it scrolls and keeps the
/// selected row in sight.
struct PaletteRows: View {
    let rows: [(item: PaletteCommand, match: FuzzyMatch)]
    let selectedID: PaletteCommand.ID?
    let showsGroups: Bool
    let run: (PaletteCommand) -> Void

    /// The rows' own height, measured, as a scroll view takes all the height it is offered.
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                list
                    .onGeometryChange(for: CGFloat.self, of: \.size.height) { height = $0 }
            }
            .frame(height: min(height, 380))
            .onChange(of: selectedID) {
                if let selectedID {
                    proxy.scrollTo(selectedID)
                }
            }
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(rows.enumerated()), id: \.element.item.id) { index, row in
                if showsGroups, index == 0 || rows[index - 1].item.group != row.item.group {
                    Text(row.item.group.rawValue)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.top, index == 0 ? 2 : 8)
                        .accessibilityAddTraits(.isHeader)
                }
                Button {
                    run(row.item)
                } label: {
                    PaletteRow(
                        command: row.item, matched: row.match.matched,
                        isSelected: row.item.id == selectedID)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.item.accessibilityLabel)
                .accessibilityAddTraits(row.item.id == selectedID ? .isSelected : [])
                .id(row.item.id)
            }
        }
        .padding(6)
    }
}

/// One row: icon, title and detail with the matched characters in bold, a channel's unread
/// counts as in the sidebar, then the shortcut, or why the command can't run now.
private struct PaletteRow: View {
    let command: PaletteCommand
    /// Offsets into `command.searchText`: the title, a space, the detail.
    let matched: [Int]
    let isSelected: Bool

    var body: some View {
        let titleLength = command.title.count
        HStack(spacing: 8) {
            Image(systemName: command.systemImage)
                .frame(width: 20)
                .foregroundStyle(isSelected ? .primary : .secondary)
            Text(highlighted(command.title, at: matched))
                .lineLimit(1)
            if let detail = command.detail {
                Text(highlighted(detail, at: matched.map { $0 - titleLength - 1 }))
                    .foregroundStyle(isSelected ? .primary : .secondary)
                    .lineLimit(1)
            }
            UnreadCriticalBadge(count: command.unreadCritical)
            Spacer(minLength: 12)
            Group {
                if let unavailable = command.unavailable {
                    Text(unavailable)
                } else if command.unread > 0 {
                    Text(command.unread.formatted())
                        .monospacedDigit()
                } else if let shortcut = command.shortcut {
                    Text(shortcut.symbols)
                }
            }
            .font(.callout)
            .foregroundStyle(isSelected ? .primary : .secondary)
            .fixedSize()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(isSelected ? .white : .primary)
        .background(isSelected ? Color.accentColor : .clear, in: .rect(cornerRadius: 6))
        .opacity(command.unavailable == nil ? 1 : 0.55)
        .contentShape(.rect)
    }

    private func highlighted(_ text: String, at offsets: [Int]) -> AttributedString {
        let offsets = Set(offsets)
        var result = AttributedString()
        for (offset, character) in text.enumerated() {
            var part = AttributedString(String(character))
            if offsets.contains(offset) {
                part.font = .body.bold()
            }
            result += part
        }
        return result
    }
}

extension PaletteCommand {
    /// What VoiceOver says for the row: everything it shows.
    var accessibilityLabel: String {
        var parts = [searchText]
        if unread > 0 {
            parts.append("\(unread) unread")
        }
        if unreadCritical > 0 {
            parts.append("\(unreadCritical) critical")
        }
        if let unavailable {
            parts.append("Unavailable: \(unavailable)")
        } else if let shortcut {
            parts.append(shortcut.spokenKeys)
        }
        return parts.joined(separator: ", ")
    }
}
