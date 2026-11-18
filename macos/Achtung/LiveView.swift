import AchtungDomain
import SwiftUI

/// Every channel's occurrences as one stream of cards (`LiveStream`), most recently changed
/// first. Beside it, the last 24 hours as a timeline (`LiveTimeline`); clicking a marker
/// scrolls to its card, expands and highlights it. The timeline goes away before the cards
/// would get narrower than `minimumCardsWidth`.
struct LiveView: View {
    private static let minimumCardsWidth: CGFloat = 520
    private static let timelineMargin: CGFloat = 10

    let occurrences: [Occurrence]
    /// Everything firing now, for the timeline's bars of alerts older than its 24 hours.
    let firing: [Occurrence]
    let readState: ReadState
    let hasOlder: Bool
    /// The last successful refresh; a failed page load retries after the next one.
    let lastUpdated: Date?
    let loadOlder: () async -> Void
    @Binding var hidesRead: Bool
    /// The expanded card (`LiveStream.kept`).
    @Binding var kept: Int?
    let markRead: (Occurrence) -> Void
    let silence: SilenceActions
    /// Requests to go back to the latest (`LiveStream.latestRequest`).
    let latestRequest: Int

    /// The latest click on a timeline marker.
    @State private var timelineClick: LiveStream.TimelineClick?

    var body: some View {
        if occurrences.isEmpty && !hasOlder {
            AllClearView()
        } else {
            GeometryReader { geometry in
                let hasTimeline =
                    geometry.size.width
                    >= Self.minimumCardsWidth + LiveTimeline.width + Self.timelineMargin
                let cardWidth =
                    geometry.size.width - 2 * LiveStream.padding
                    - (hasTimeline ? LiveTimeline.width + Self.timelineMargin : 0)
                HStack(spacing: 0) {
                    LiveStream(
                        occurrences: occurrences, readState: readState, hasOlder: hasOlder,
                        lastUpdated: lastUpdated, loadOlder: loadOlder, hidesRead: $hidesRead,
                        kept: $kept, markRead: markRead, silence: silence,
                        showsTimes: cardWidth >= LiveCard.timesWidth, timelineClick: timelineClick,
                        latestRequest: latestRequest)
                    if hasTimeline {
                        LiveTimeline(occurrences: occurrences + firing, readState: readState) {
                            timelineClick = LiveStream.TimelineClick(
                                occurrence: $0, number: (timelineClick?.number ?? 0) + 1)
                        }
                        .frame(width: LiveTimeline.width)
                        .paneCard()
                        .padding([.top, .trailing, .bottom], Self.timelineMargin)
                    }
                }
            }
        }
    }
}

#Preview {
    LiveView(
        occurrences: SampleData.occurrences, firing: [], readState: SampleData.readState,
        hasOlder: false, lastUpdated: nil, loadOlder: {}, hidesRead: .constant(false),
        kept: .constant(nil), markRead: { _ in },
        silence: .none, latestRequest: 0)
}
