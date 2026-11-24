import AchtungDomain
import Foundation

/// Where the cards and the stream were at the last layout, to hold the expanded card still
/// (`LiveStream.holdStill`). Not observed: it changes on every layout and scroll, and nothing
/// draws from it.
final class ExpandedCardAnchor {
    /// A card to keep where it is on screen through the change being made.
    struct Held {
        let id: AlertIdentity
        /// Its top from the top of the stream's visible part, before the change.
        let onScreen: CGFloat
        /// A change that doesn't move it leaves nothing to do: past this, a later layout
        /// isn't the change's.
        let until: Date
    }

    /// Each card's top in the stream's content, as last laid out. A row the lazy stream let
    /// go keeps its last top until the card leaves the stream: holding such a card still
    /// reads a stale top, which only matters if it's laid out again within `Held.until`.
    var tops: [AlertIdentity: CGFloat] = [:]
    /// The stream's scroll offset.
    var offset: CGFloat = 0
    var held: Held?
    /// The card being scrolled to the top, which isn't held where it was, until it's laid
    /// out.
    var revealing: AlertIdentity?

    /// Lets go of the cards no longer in the stream.
    func forget(allBut ids: [AlertIdentity]) {
        let kept = Set(ids)
        tops = tops.filter { kept.contains($0.key) }
    }
}
