import AchtungDomain
import SwiftUI

// A channel's two panes, the list and the open alert's detail, and what a list shows
// until its first page arrives.
extension InboxView {
    func hidesRead(in scope: OccurrenceScope) -> Binding<Bool> {
        Binding {
            model.hidesRead(in: scope)
        } set: {
            model.setHidesRead($0, in: scope)
        }
    }

    @ViewBuilder func channelList(_ channel: ChannelID) -> some View {
        let scope = OccurrenceScope.channel(channel)
        if let occurrences = model.shownOccurrences(
            in: scope, keeping: selectedID, revealing: revealed)
        {
            let hidingRead = model.hidesRead(in: scope)
            AlertList(
                occurrences: occurrences, readState: model.readState,
                // Hidden while read alerts are: the feed already brought every unread one,
                // so older pages would add nothing to show.
                hasOlder: !hidingRead && model.hasOlder(in: scope),
                lastUpdated: model.lastUpdated,
                loadOlder: { await model.loadOlder(in: scope) },
                hidesRead: hidesRead(in: scope),
                selection: $selectedID, copy: copy, silence: SilenceActions(model))
        } else {
            loading(scope)
        }
    }

    /// Until a list's first page arrives. If loading it failed, say why instead of
    /// spinning; the next refresh retries.
    @ViewBuilder func loading(_ scope: OccurrenceScope) -> some View {
        if let problem = model.problem {
            UnreachableView(problem: problem, baseURL: model.baseURL) {
                Task { await model.refresh(scope, visiting: true) }
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Copies an occurrence for an agent, with its history when it's the open alert's,
    /// which has loaded it.
    func copy(_ occurrence: Occurrence) {
        let detail = model.detail?.occurrence.id == occurrence.id ? model.detail : nil
        copyForAgent(occurrence, events: detail?.events)
    }

    @ViewBuilder var occurrenceDetail: some View {
        if let occurrence = selectedOccurrence {
            AlertDetailView(
                occurrence: occurrence,
                detail: model.detail?.occurrence.id == occurrence.id ? model.detail : nil,
                detailProblem: model.detailProblem,
                silence: SilenceActions(model),
                graph: graphs?.load,
                loadGraph: graphs.map { graphs in { await graphs.load($0, of: occurrence) } })
        } else {
            ContentUnavailableView("Select an alert", systemImage: "bell")
        }
    }
}
