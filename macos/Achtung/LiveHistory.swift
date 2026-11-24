import AchtungDomain
import SwiftUI

/// An expanded Live card's earlier occurrences, the ones folded into it besides the latest,
/// newest first: when each fired and resolved and how long it lasted, whether it's unread,
/// and a reminder pending on it. Up to `limit` of them, more when the one a timeline marker
/// was clicked for is further down, so it's there to highlight.
struct LiveHistory: View {
    private static let limit = 20

    let alert: LiveAlert
    let readState: ReadState
    /// The occurrence a timeline marker was clicked for, highlighted for a moment.
    let highlighted: Int?

    private var shown: ArraySlice<Occurrence> {
        let earlier = alert.earlier
        let throughHighlighted =
            earlier.firstIndex { $0.id == highlighted }.map { $0 - earlier.startIndex + 1 } ?? 0
        return earlier.prefix(max(Self.limit, throughHighlighted))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Earlier occurrences")
                    .font(.headline)
                RepeatCount(alert: alert)
            }
            ForEach(shown) { occurrence in
                HStack(spacing: 8) {
                    UnreadMark(occurrence: occurrence, isRead: readState.isRead(occurrence))
                    OccurrenceSpanRow(occurrence: occurrence)
                    if let remindAt = occurrence.remindAt {
                        ReminderPill(date: remindAt)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    highlighted == occurrence.id ? Color.accentColor.opacity(0.2) : .clear,
                    in: .rect(cornerRadius: 6))
            }
            if alert.earlier.count > shown.count {
                Text("…and \(alert.earlier.count - shown.count) more")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// "5× since 08:12": how many of an alert's occurrences a Live card holds, the latest and
/// those folded into it, since the oldest of them started. A count that may miss some,
/// because Live hasn't loaded back that far, leaves the span out rather than claim it.
/// Nothing for an alert that occurred once.
struct RepeatCount: View {
    let alert: LiveAlert

    var body: some View {
        if alert.occurrences.count > 1 {
            Label(text, systemImage: "repeat")
                .font(.caption.weight(.semibold).monospacedDigit())
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .foregroundStyle(.secondary)
                .background(.quaternary, in: Capsule())
                .help(help)
        }
    }

    private var count: Int { alert.occurrences.count }

    private var text: String {
        alert.isCountComplete ? "\(count)× since \(dayAndTime(alert.since))" : "\(count)×"
    }

    private var help: String {
        alert.isCountComplete
            ? "Fired \(count) times since \(exactDateTime(alert.since)). Expand for each one."
            : "\(count) of its occurrences are loaded, the oldest started "
                + "\(exactDateTime(alert.since)). There may be more that Live hasn't loaded."
    }
}
