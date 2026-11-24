import AchtungDomain
import SwiftUI

/// What Achtung tracked about the occurrence, beyond what the source reported, as a Live
/// card shows it. The detail pane shows the same in `AlertMetadataPanel`.
struct OccurrenceFacts: View {
    let occurrence: Occurrence

    var body: some View {
        FactsSection(
            title: "Delivery",
            facts: [("Source", occurrence.source)] + deliveryFacts(of: occurrence))
    }
}

/// How often and when the occurrence's notifications arrived.
func deliveryFacts(of occurrence: Occurrence) -> [(name: String, value: String)] {
    [
        ("Notifications", occurrence.notificationCount.formatted()),
        ("First received", exactDateTime(occurrence.firstReceivedAt)),
        ("Last received", exactDateTime(occurrence.lastReceivedAt)),
    ]
}

/// A heading over name/value rows.
struct FactsSection: View {
    let title: String
    let facts: [(name: String, value: String)]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                ForEach(facts, id: \.name) { fact in
                    GridRow {
                        Text(fact.name).foregroundStyle(.secondary)
                        Text(fact.value).textSelection(.enabled)
                    }
                }
            }
            .font(.callout)
        }
    }
}

/// The occurrence's events, oldest first, and the alert's other occurrences.
struct OccurrenceHistory: View {
    let detail: OccurrenceDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("History")
                    .font(.headline)
                ForEach(detail.events) { event in
                    EventRow(event: event)
                }
            }
            if !detail.otherOccurrences.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    // Can hold newer ones too, when an older occurrence is open.
                    Text("Other occurrences")
                        .font(.headline)
                    ForEach(detail.otherOccurrences) { other in
                        OccurrenceSpanRow(occurrence: other)
                    }
                }
            }
        }
    }
}

/// One occurrence of an alert in a list of them: whether it fires, when it fired and
/// resolved, and how long it lasted. The detail pane's other occurrences and a Live card's
/// earlier ones.
struct OccurrenceSpanRow: View {
    let occurrence: Occurrence

    private var alert: IncomingAlert { occurrence.alert }

    var body: some View {
        HStack(spacing: 8) {
            StatusPill(alert: alert)
            Text(span(dayAndTime))
                .font(.callout)
                .foregroundStyle(.secondary)
                .help(span(exactDateTime))
        }
        .accessibilityElement(children: .combine)
    }

    /// "Fired 14:02 · Resolved 14:07 · 5m", or "Fired 14:02" while it fires.
    private func span(_ format: (Date) -> String) -> String {
        let fired = "Fired \(format(alert.startsAt))"
        guard case .resolved(let endsAt) = alert.state else { return fired }
        let lasted = Duration.seconds(max(endsAt.timeIntervalSince(alert.startsAt), 0))
            .formatted(
                .units(
                    allowed: [.days, .hours, .minutes, .seconds], width: .narrow,
                    maximumUnitCount: 2))
        return "\(fired) · Resolved \(format(endsAt)) · \(lasted)"
    }
}

/// One event: what happened and when. A resolve Achtung recorded itself (ADR 0014) says so,
/// and why.
private struct EventRow: View {
    let event: OccurrenceEvent

    private var vanished: Bool { event.cause == .vanished }

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(event.kind.title) \(exactDateTime(event.recordedAt))")
                if let remindAt = event.remindAt {
                    Text("For \(exactDateTime(remindAt))")
                        .foregroundStyle(.secondary)
                }
                if vanished {
                    Text("Gone from Alertmanager")
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(
                systemName: vanished
                    ? "checkmark.circle.badge.questionmark.fill" : event.kind.symbolName
            )
            .foregroundStyle(event.kind.color)
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
        .modifier(VanishedHelp(isVanished: vanished))
    }
}

/// Why a vanished resolve has no notification behind it; nothing on other events.
private struct VanishedHelp: ViewModifier {
    let isVanished: Bool

    func body(content: Content) -> some View {
        if isVanished {
            content.help(
                "Alertmanager never sent this resolve. The alert was gone from it, so Achtung "
                    + "resolved it itself after 5 minutes without it. Typically an alert that "
                    + "ended while silenced or inhibited.")
        } else {
            content
        }
    }
}

/// A date and time in full, for facts and triage.
func exactDateTime(_ date: Date) -> String {
    date.formatted(date: .abbreviated, time: .shortened)
}

extension OccurrenceEvent.Kind {
    fileprivate var title: String {
        switch self {
        case .fired: "Fired"
        case .resolved: "Resolved"
        case .reopened: "Reopened"
        case .resent: "Resent"
        case .reminderSet: "Reminder set"
        case .reminderCancelled: "Reminder cancelled"
        case .reminded: "Reminder"
        }
    }

    fileprivate var symbolName: String {
        switch self {
        case .fired: "flame.fill"
        case .resolved: "checkmark.circle.fill"
        case .reopened: "arrow.uturn.backward.circle.fill"
        case .resent: "arrow.clockwise.circle.fill"
        case .reminderSet: "alarm"
        case .reminderCancelled: "xmark.circle"
        case .reminded: "alarm.fill"
        }
    }

    fileprivate var color: Color {
        switch self {
        // Red stays reserved for critical severity.
        case .fired, .reopened: .primary
        case .resolved: .green
        case .resent, .reminderSet, .reminderCancelled: .secondary
        case .reminded: .primary
        }
    }
}
