import AchtungAPI
import AchtungDomain
import SwiftUI

/// A channel's detail pane: what the source reported in the main column, and the
/// occurrence's metadata (channel, identity, delivery, history) in a panel on the right.
/// Each scrolls on its own. When the pane is too narrow for both, the panel goes below.
struct AlertDetailView: View {
    /// Narrower than this, the panel stacks below the main column.
    private static let sideBySideWidth: CGFloat = 400 + AlertMetadataPanel.width
    /// The panel card's distance from the pane's edges.
    private static let cardMargin: CGFloat = 10

    let occurrence: Occurrence
    /// Nil while the history is loading, or when it failed to load.
    let detail: OccurrenceDetail?
    let detailProblem: ServerError?
    let silence: SilenceActions
    /// The open alert's graph as last loaded, and how to (re)load it (ADR 0026).
    var graph: GraphLoad?
    var loadGraph: ((MetricPanel) async -> Void)?

    var body: some View {
        GeometryReader { geometry in
            if geometry.size.width >= Self.sideBySideWidth {
                HStack(spacing: 0) {
                    ScrollView {
                        details
                            .padding(24)
                    }
                    // The card's contents scroll inside it; the main column's padding is
                    // the gap on its left.
                    ScrollView {
                        panel
                    }
                    .frame(width: AlertMetadataPanel.width)
                    .paneCard()
                    .padding([.top, .trailing, .bottom], Self.cardMargin)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        details
                            .padding(24)
                        panel
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .paneCard()
                            .padding(Self.cardMargin)
                    }
                }
            }
        }
    }

    private var details: some View {
        AlertDetails(
            occurrence: occurrence, silence: silence, events: detail?.events,
            hasCopyShortcut: true, graph: podCPUGraph)
    }

    /// Shown once the detail says the server has the graph for this alert: an alert without
    /// a pod, or on an instance without a metrics backend, has no card at all.
    private var podCPUGraph: PodCPUGraph? {
        guard let loadGraph, detail?.occurrence.id == occurrence.id,
            detail?.metricPanels.contains(.podCPU) == true
        else { return nil }
        return PodCPUGraph(occurrence: occurrence, load: graph) {
            await loadGraph(.podCPU)
        }
    }

    private var panel: some View {
        AlertMetadataPanel(occurrence: occurrence, detail: detail, detailProblem: detailProblem)
            .padding(20)
    }
}

/// What the source reported about one occurrence: header, the summary and description to
/// read, links and the silence and copy buttons, then every annotation and every label,
/// one per line. Shared by the channel detail pane and the Live cards, which put the
/// alert's earlier occurrences (`history`) under the buttons, before the annotations.
struct AlertDetails<History: View>: View {
    let occurrence: Occurrence
    let silence: SilenceActions
    /// The history, for "Copy for Agent", once it has loaded; Live's cards don't have it.
    var events: [OccurrenceEvent]?
    /// ⇧⌘C copies and ⇧⌘R reminds: only in the detail pane, where one alert is shown.
    var hasCopyShortcut = false
    /// Collapses a Live card when its header is clicked; nil in the detail pane.
    var collapse: (() -> Void)?
    /// The CPU graph of the alert's pod, under the summary and actions; only the detail pane
    /// has it (ADR 0026).
    var graph: PodCPUGraph?
    @ViewBuilder var history: () -> History

    private var alert: IncomingAlert { occurrence.alert }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            SilenceState(occurrence: occurrence) { isSilenced in
                VStack(alignment: .leading, spacing: 20) {
                    header(isSilenced: isSilenced)
                    AlertProse(alert: alert)
                    FlowLayout(spacing: 8) {
                        AlertLinkButtons(alert: alert)
                        // A new occurrence gets a fresh button, without the last one's error
                        // or in-flight state.
                        SilenceButton(
                            occurrence: occurrence, isSilenced: isSilenced, actions: silence
                        )
                        .id(occurrence.id)
                        ReminderButton(occurrence: occurrence, hasShortcut: hasCopyShortcut)
                            .id(occurrence.id)
                        CopyForAgentButton(
                            occurrence: occurrence, events: events, hasShortcut: hasCopyShortcut
                        )
                        .id(occurrence.id)
                    }
                }
            }
            graph
            history()
            AnnotationsSection(alert: alert)
            LabelsSection(alert: alert)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(isSilenced: Bool) -> some View {
        AlertHeader(
            alert: alert, silencedUntil: isSilenced ? occurrence.silencedUntil : nil,
            resurfaced: Resurfaced(occurrence), remindAt: occurrence.remindAt,
            collapse: collapse)
    }
}

extension AlertDetails where History == EmptyView {
    init(
        occurrence: Occurrence, silence: SilenceActions, events: [OccurrenceEvent]? = nil,
        hasCopyShortcut: Bool = false, collapse: (() -> Void)? = nil, graph: PodCPUGraph? = nil
    ) {
        self.init(
            occurrence: occurrence, silence: silence, events: events,
            hasCopyShortcut: hasCopyShortcut, collapse: collapse, graph: graph
        ) {
            EmptyView()
        }
    }
}

private struct AlertHeader: View {
    let alert: IncomingAlert
    let silencedUntil: Date?
    let resurfaced: Resurfaced?
    let remindAt: Date?
    /// Collapses a Live card on a click on the icon, title or status; the times stay
    /// selectable.
    let collapse: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            SeverityIcon(severity: alert.severity)
                .collapsing(collapse)
            VStack(alignment: .leading, spacing: 8) {
                Text(alert.title)
                    .font(.title.bold())
                    .collapsing(collapse)
                // On one line when it fits; a silence, a reminder and a resend together are
                // wider than a narrow pane, and wrap whole.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { status }
                        .fixedSize()
                    FlowLayout(spacing: 8) { status }
                }
                .font(.callout)
                .collapsing(collapse)
                Text(alert.times())
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

extension AlertHeader {
    private var status: some View {
        AlertStatus(
            alert: alert, silencedUntil: silencedUntil, resurfaced: resurfaced,
            remindAt: remindAt)
    }
}

extension View {
    /// Calls `collapse`, if there is one, on a click anywhere in the view.
    @ViewBuilder fileprivate func collapsing(_ collapse: (() -> Void)?) -> some View {
        if let collapse {
            contentShape(.rect).onTapGesture(perform: collapse)
        } else {
            self
        }
    }
}

/// The alert's severity as a large white symbol on its colour, leading its header.
struct SeverityIcon: View {
    let severity: Severity

    var body: some View {
        Image(systemName: severity.symbolName)
            .font(.system(size: 26))
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(severity.color.gradient, in: .rect(cornerRadius: 12))
    }
}

/// Why an occurrence is unread again without being new: its source resent it, or a
/// reminder set on it came due (ADR 0009, ADR 0025).
enum Resurfaced: Equatable {
    case resent(Date)
    case reminded(Date)

    init?(_ occurrence: Occurrence) {
        if occurrence.isResent {
            self = .resent(occurrence.lastEventAt)
        } else if occurrence.isReminded {
            self = .reminded(occurrence.lastEventAt)
        } else {
            return nil
        }
    }
}

/// The line under an alert's title: its status, resend or reminder, silence, pending
/// reminder, severity and, unless left out for room, how long ago it started. No container
/// of its own, so a row or a flow can hold it.
struct AlertStatus: View {
    let alert: IncomingAlert
    let silencedUntil: Date?
    let resurfaced: Resurfaced?
    var remindAt: Date?
    var showsAge = true

    var body: some View {
        StatusPill(alert: alert)
        switch resurfaced {
        case .resent(let date): ResentPill(date: date)
        case .reminded(let date): RemindedPill(date: date)
        case nil: EmptyView()
        }
        if let silencedUntil {
            SilencedPill(until: silencedUntil)
        }
        if let remindAt {
            ReminderPill(date: remindAt)
        }
        Text(alert.severity.rawValue.capitalized)
            .foregroundStyle(alert.severity.color)
        if showsAge {
            RelativeTime(date: alert.startsAt)
                .foregroundStyle(.secondary)
        }
    }
}

extension IncomingAlert {
    /// When it started and, once resolved, ended: exact times for triage, beside the
    /// relative time that is for scanning.
    func times(_ format: (Date) -> String = exactDateTime) -> String {
        let started = "Started \(format(startsAt))"
        switch state {
        case .firing:
            return started
        case .resolved(let endsAt):
            return "\(started) · Resolved \(format(endsAt))"
        }
    }
}
