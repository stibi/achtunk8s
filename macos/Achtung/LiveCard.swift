import AchtungDomain
import SwiftUI

/// One alert in Live, showing its latest occurrence, with the earlier ones it has loaded
/// folded in (`LiveAlert`). Collapsed, as every card starts, it is about as tall as the
/// alert's icon: the header on the left, with how many times it occurred when more than
/// once, and on the right the summary, the exact times and the channel. Clicking it
/// anywhere expands it into all its details, with the buttons, and the earlier occurrences
/// (`LiveHistory`); clicking the expanded header (or the chevron) collapses it again. Unread
/// cards, any of whose occurrences is unread, carry a dot (a circular arrow when resent) and
/// an accent border; read ones fade.
struct LiveCard: View {
    /// Narrower than this, a collapsed card leaves the times out of its right side: the
    /// relative age on the left stays, and the tooltip on the title has them.
    static let timesWidth: CGFloat = 600

    let alert: LiveAlert
    let readState: ReadState
    let isExpanded: Bool
    /// Shown briefly after a timeline marker was clicked.
    let isHighlighted: Bool
    /// The clicked marker's occurrence, highlighted in the history with the card.
    let highlightedOccurrence: Int?
    /// Where the keyboard is in the stream (↑ and ↓ move it).
    let hasKeyboardFocus: Bool
    /// Leaves the times out when the card is narrow (`timesWidth`).
    let showsTimes: Bool
    let silence: SilenceActions
    let expand: () -> Void
    let collapse: () -> Void
    /// A click on the expanded card marks it read again, after a resend while it's open.
    let markRead: () -> Void

    /// The card shows its latest occurrence; the buttons act on it.
    private var occurrence: Occurrence { alert.latest }
    private var isRead: Bool { alert.isRead(in: readState) }
    /// What the unread mark tells: why the card is unread, else its latest.
    private var marked: Occurrence { alert.lastUnread(in: readState) ?? occurrence }

    var body: some View {
        Group {
            if isExpanded {
                expanded
                    .padding(20)
            } else {
                CollapsedLiveCard(
                    alert: alert, marked: marked, isRead: isRead, showsTimes: showsTimes
                )
                .padding(.horizontal, 20)
                .padding(.vertical, 14)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: .rect(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(isRead ? Color.clear : Color.accentColor.opacity(0.5))
        }
        .opacity(isRead && !isHighlighted && !isExpanded ? 0.6 : 1)
        .overlay {
            if isHighlighted {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(Color.accentColor, lineWidth: 3)
            }
        }
        .overlay {
            if hasKeyboardFocus {
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(Color.accentColor.opacity(0.6), lineWidth: 3)
                    .padding(-4)
            }
        }
        .contentShape(.rect(cornerRadius: 14))
        // Buttons, links and selectable text inside keep their own clicks.
        .simultaneousGesture(TapGesture().onEnded(isExpanded ? markRead : expand))
        .accessibilityElement(children: isExpanded ? .contain : .combine)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(isExpanded ? [] : .isButton)
        .accessibilityAction(.default, toggle)
        .accessibilityAction(named: isExpanded ? "Collapse" : "Expand", toggle)
    }

    private func toggle() {
        if isExpanded {
            collapse()
        } else {
            expand()
        }
    }

    /// The full card: the channel, every detail of the latest occurrence with the earlier
    /// ones under its buttons, and the latest's delivery.
    private var expanded: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                UnreadMark(occurrence: marked, isRead: isRead)
                Text("\(occurrence.channel.instance) · #\(occurrence.channel.slug)")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Collapse", systemImage: "chevron.up", action: collapse)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help("Collapse")
            }
            VStack(alignment: .leading, spacing: 24) {
                AlertDetails(occurrence: occurrence, silence: silence, collapse: collapse) {
                    if !alert.earlier.isEmpty {
                        LiveHistory(
                            alert: alert, readState: readState,
                            highlighted: highlightedOccurrence)
                    }
                }
                OccurrenceFacts(occurrence: occurrence)
            }
        }
    }
}

/// A collapsed card's one line. Left: the unread mark, the severity icon, the title and
/// under it the status, led by the count of occurrences when there are several (a row that
/// drops the age, then wraps, when there's no room).
/// Right: the summary, the times and the channel, one line each. The title gets its width
/// first and truncates last; the summary truncates first.
private struct CollapsedLiveCard: View {
    /// The right side's least width beside a long title, so the summary and the channel
    /// never shrink to a lone "…".
    private static let rightMinimumWidth: CGFloat = 120

    let liveAlert: LiveAlert
    /// The occurrence the unread mark is about (`LiveCard.marked`).
    let marked: Occurrence
    let isRead: Bool
    let showsTimes: Bool

    init(alert: LiveAlert, marked: Occurrence, isRead: Bool, showsTimes: Bool) {
        self.liveAlert = alert
        self.marked = marked
        self.isRead = isRead
        self.showsTimes = showsTimes
    }

    private var occurrence: Occurrence { liveAlert.latest }
    private var alert: IncomingAlert { occurrence.alert }

    var body: some View {
        SilenceState(occurrence: occurrence) { isSilenced in
            HStack(spacing: 14) {
                UnreadMark(occurrence: marked, isRead: isRead)
                SeverityIcon(severity: alert.severity)
                VStack(alignment: .leading, spacing: 6) {
                    Text(alert.title)
                        .font(.title.bold())
                        .lineLimit(1)
                        .help(showsTimes ? alert.title : "\(alert.title)\n\(alert.times())")
                    status(silencedUntil: isSilenced ? occurrence.silencedUntil : nil)
                        .font(.callout)
                }
                .layoutPriority(2)
                Spacer(minLength: 16)
                VStack(alignment: .trailing, spacing: 4) {
                    if let summary = alert.summary {
                        Text(summary)
                            .lineLimit(1)
                            .help(summary)
                    }
                    if showsTimes {
                        ViewThatFits(in: .horizontal) {
                            Text(alert.times(dayAndTime))
                            Text(alert.times { $0.formatted(date: .omitted, time: .shortened) })
                        }
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                        .help(alert.times())
                    }
                    Text("\(occurrence.channel.instance) · #\(occurrence.channel.slug)")
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .font(.callout)
                .frame(minWidth: Self.rightMinimumWidth, alignment: .trailing)
                .layoutPriority(1)
            }
        }
    }

    @ViewBuilder private func status(silencedUntil: Date?) -> some View {
        let resurfaced = Resurfaced(occurrence)
        // An earlier occurrence's pending reminder stays in view when the latest has none.
        let remindAt = occurrence.remindAt ?? liveAlert.earlierReminders.first?.remindAt
        // The rows keep their pills whole: when one doesn't fit, the next takes its place.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                RepeatCount(alert: liveAlert)
                AlertStatus(
                    alert: alert, silencedUntil: silencedUntil, resurfaced: resurfaced,
                    remindAt: remindAt)
            }
            .fixedSize()
            HStack(spacing: 8) {
                RepeatCount(alert: liveAlert)
                AlertStatus(
                    alert: alert, silencedUntil: silencedUntil, resurfaced: resurfaced,
                    remindAt: remindAt, showsAge: false)
            }
            .fixedSize()
            FlowLayout(spacing: 8) {
                RepeatCount(alert: liveAlert)
                AlertStatus(
                    alert: alert, silencedUntil: silencedUntil, resurfaced: resurfaced,
                    remindAt: remindAt, showsAge: false)
            }
        }
    }
}

/// The time alone today, else with the day: short enough for a collapsed card.
func dayAndTime(_ date: Date) -> String {
    Calendar.current.isDateInToday(date)
        ? date.formatted(date: .omitted, time: .shortened)
        : date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
}
