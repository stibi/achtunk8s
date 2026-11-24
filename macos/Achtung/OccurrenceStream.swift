import AchtungDomain
import SwiftUI

/// The rows every occurrence list shares, for a `List` or a `LazyVStack` to hold: what
/// changed since the user last left the app, a "new" divider, the rest, and at the end a
/// row that loads the next older page when it appears. Live's rows are alerts
/// (`LiveAlert`), each with its occurrences folded in.
struct OccurrenceStream<Item: Identifiable & Changing, Row: View>: View {
    let occurrences: [Item]
    let readState: ReadState
    let hasOlder: Bool
    /// The last successful refresh; a failed page load retries after the next one.
    let lastUpdated: Date?
    let loadOlder: () async -> Void
    @ViewBuilder let row: (Item) -> Row

    var body: some View {
        let order = readState.newFirst(occurrences)
        ForEach(order.new, content: row)
        if let seenUntil = readState.seenUntil, !order.new.isEmpty {
            NewDivider(seenUntil: seenUntil)
        }
        ForEach(order.earlier, content: row)
        if hasOlder {
            ProgressView()
                .frame(maxWidth: .infinity)
                .task(id: [occurrences.count, lastUpdated] as [AnyHashable?]) {
                    await loadOlder()
                }
        }
    }
}
