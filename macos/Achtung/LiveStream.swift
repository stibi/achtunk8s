import AchtungDomain
import SwiftUI

/// Live's cards (`LiveCard`), most recently changed first; what changed since the user last
/// left the app sits above a "new" divider. Scrolling to the end loads older pages.
///
/// Cards are collapsed. Expanding one (a click, Return or Space, or a timeline marker)
/// marks it read and makes it `kept`, and collapses the one expanded before: at most one
/// is. With read alerts hidden, the stream holds only new ones and resends, and the
/// expanded card until another is, so clicking down the stream clears it. The expanded card
/// holds still on screen while what's above it changes: a card collapsing or leaving, a new
/// alert arriving. ↑ and ↓ move the keyboard between cards. A successful silence from the
/// expanded card collapses it, as the user is done with it. Esc, or choosing Live again,
/// goes back to the latest (`showLatest`).
struct LiveStream: View {
    /// A click on a timeline marker, numbered so that each one counts, even on the same
    /// card.
    struct TimelineClick: Equatable {
        let occurrence: Occurrence
        let number: Int
    }

    static let padding: CGFloat = 24
    /// The stream's content, where cards measure where they are.
    nonisolated private static let content = "content"

    let occurrences: [Occurrence]
    let readState: ReadState
    let hasOlder: Bool
    /// The last successful refresh; a failed page load retries after the next one.
    let lastUpdated: Date?
    let loadOlder: () async -> Void
    @Binding var hidesRead: Bool
    /// The expanded card, the one the user last opened. It stays in the stream once read,
    /// until another one takes its place, the user collapses it or marks all read.
    @Binding var kept: Int?
    let markRead: (Occurrence) -> Void
    let silence: SilenceActions
    /// Collapsed cards show their times (`LiveCard.timesWidth`).
    let showsTimes: Bool
    let timelineClick: TimelineClick?
    /// Counts requests to go back to the latest (`showLatest`): Live chosen or opened again
    /// while it's shown.
    let latestRequest: Int

    /// The card a timeline marker was clicked for, highlighted for a moment.
    @State var highlighted: Int?
    /// Counts clicks, so each one restarts the highlight's two seconds, even on the same
    /// card.
    @State private var highlightRequest = 0
    /// The card to scroll to the top once the update that expands it is laid out: one
    /// shown from the timeline or opened from the keyboard.
    @State private var revealed: Int?
    @State private var revealRequest = 0
    /// The card ↑ and ↓ moved to; nil after a click, so they go on from the expanded one.
    @State var keyboardCard: Int?
    /// The stream takes the keyboard when a card opens, also from the timeline, so ↑, ↓
    /// and Esc work from there.
    @FocusState private var hasFocus: Bool
    /// Room above the stream for a card that left above the expanded one, when the stream
    /// can't scroll back as far as it was tall: the expanded card opens where it was, then
    /// the room eases away (`moved`).
    @State private var topSlack: CGFloat = 0
    @State var position = ScrollPosition()
    @State private var anchor = ExpandedCardAnchor()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var shown: [Occurrence] {
        readState.shown(own: occurrences, feed: occurrences, in: .allChannels, keeping: kept)
    }

    /// The cards as the stream lists them, for ↑ and ↓.
    var order: [Int] {
        let order = readState.newFirst(shown)
        return (order.new + order.earlier).map(\.id)
    }

    var animation: Animation? {
        reduceMotion ? nil : .default
    }

    var body: some View {
        Group {
            if shown.isEmpty && hidesRead {
                CaughtUpView(coffeeBreak: true) { hidesRead = false }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    scrolling(proxy)
                }
            }
        }
        .onChange(of: timelineClick) {
            if let timelineClick { show(timelineClick.occurrence) }
        }
        .onChange(of: latestRequest) { showLatest() }
        // Ends the highlight two seconds after the latest click; a new click restarts it.
        .task(id: highlightRequest) {
            guard highlighted != nil else { return }
            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return  // Cancelled: another click, or the view went away.
            }
            withAnimation { highlighted = nil }
        }
    }

    private func scrolling(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            cards
        }
        .scrollPosition($position)
        // As `scrollTo(y:)` takes it: from the top of the content, under the toolbar's inset.
        .onScrollGeometryChange(for: CGFloat.self) {
            $0.contentOffset.y + $0.contentInsets.top
        } action: { _, offset in
            anchor.offset = offset
        }
        .onChange(of: shown.map(\.id)) { _, ids in
            if let kept { holdStill(kept) }
            anchor.forget(allBut: ids)
        }
        .focusable()
        .focused($hasFocus)
        .focusEffectDisabled()
        .onKeyPress(Shortcut.selectNext.keyEquivalent) { moveKeyboard(by: 1, with: proxy) }
        .onKeyPress(Shortcut.selectPrevious.keyEquivalent) { moveKeyboard(by: -1, with: proxy) }
        .onKeyPress(keys: [Shortcut.open.keyEquivalent, Shortcut.toggleCard.keyEquivalent]) { _ in
            toggleKeyboardCard()
        }
        .onKeyPress(Shortcut.back.keyEquivalent) { escape() }
        // After the update that put a hidden card back into the stream, so it's there to
        // scroll to; on appearing too, for a click while the stream was all caught up.
        .onChange(of: revealRequest) { scrollToRevealed(with: proxy) }
        .onAppear { scrollToRevealed(with: proxy) }
        .task(id: topSlack) {
            guard topSlack > 0 else { return }
            do {
                try await Task.sleep(for: .seconds(0.4))
            } catch {
                return  // Cancelled: more room was needed, or the view went away.
            }
            withAnimation(animation) { topSlack = 0 }
        }
    }

    private var cards: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            // Older pages hold read alerts only: the feed is loaded down to the read
            // baseline, so while they're hidden there's nothing more to load.
            OccurrenceStream(
                occurrences: shown, readState: readState, hasOlder: hasOlder && !hidesRead,
                lastUpdated: lastUpdated, loadOlder: loadOlder
            ) { occurrence in
                LiveCard(
                    occurrence: occurrence, isRead: readState.isRead(occurrence),
                    isExpanded: kept == occurrence.id,
                    isHighlighted: highlighted == occurrence.id,
                    hasKeyboardFocus: keyboardCard == occurrence.id,
                    showsTimes: showsTimes,
                    // Silenced, the user is done with it; unless they've opened another.
                    silence: silence.whenSilenced {
                        if kept == $0.id { collapseHandingOnKeyboard() }
                    },
                    expand: {
                        keyboardCard = nil
                        expand(occurrence)
                    },
                    collapse: collapse,
                    markRead: { markRead(occurrence) }
                )
                .id(occurrence.id)
                .onGeometryChange(for: CGFloat.self) {
                    $0.frame(in: .named(Self.content)).minY
                } action: { top in
                    moved(occurrence.id, to: top)
                }
            }
        }
        .coordinateSpace(.named(Self.content))
        .padding(Self.padding)
        .padding(.top, topSlack)
        // Not while a card is expanded: what changes above it then (a new alert, a read
        // one leaving) lands at once, held still under it (`holdStill`).
        .animation(kept == nil ? animation : nil, value: shown.map(\.id))
    }

    /// Expands `occurrence`'s card, collapsing the one expanded before, and marks it read.
    /// The card holds still on screen (`holdStill`). When the one before is above it, the
    /// change isn't animated: the stream scrolls by what it lost above in the same frame,
    /// and an animation would slide the cards above through it on the way.
    private func expand(_ occurrence: Occurrence) {
        holdStill(occurrence.id)
        let order = order
        let isBelowExpanded =
            if let kept, let above = order.firstIndex(of: kept),
                let index = order.firstIndex(of: occurrence.id)
            {
                above < index
            } else {
                false
            }
        var transaction = Transaction(animation: isBelowExpanded ? nil : animation)
        transaction.disablesAnimations = isBelowExpanded
        withTransaction(transaction) {
            kept = occurrence.id
            markRead(occurrence)
        }
        hasFocus = true
    }

    /// With read alerts hidden, a read card leaves the stream as it collapses.
    func collapse() {
        withAnimation(animation) { kept = nil }
    }

    /// Before a change that can move card `id` in the stream (it expands, or one above it
    /// collapses, leaves or arrives), notes where it is on screen, so that it holds still
    /// there once the change is laid out (`moved`).
    private func holdStill(_ id: Int) {
        guard anchor.revealing != id, let top = anchor.tops[id] else { return }
        anchor.held = ExpandedCardAnchor.Held(
            id: id, onScreen: top + topSlack - anchor.offset, until: .now + 0.5)
    }

    /// Card `id` was laid out with its top at `top` in the stream. If it's held, the stream
    /// scrolls in the same frame to keep it where it was on screen. Past the top,
    /// `topSlack` makes up the rest.
    private func moved(_ id: Int, to top: CGFloat) {
        anchor.tops[id] = top
        guard let held = anchor.held, held.id == id else { return }
        anchor.held = nil
        guard held.until > .now else { return }
        let target = top + topSlack - held.onScreen
        if target < 0 {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { topSlack -= target }
        }
        anchor.offset = max(0, target)
        position.scrollTo(y: anchor.offset)
    }

    /// Scrolls the stream to `occurrence`'s card, expands it and highlights it for two
    /// seconds: a timeline marker was clicked. A read card hidden from the stream comes
    /// back first.
    private func show(_ occurrence: Occurrence) {
        keyboardCard = nil
        reveal(occurrence)
        highlighted = occurrence.id
        highlightRequest += 1
    }

    /// Expands `occurrence`'s card and scrolls it to the top, after the update.
    func reveal(_ occurrence: Occurrence) {
        // It's scrolled to, so it isn't held where it was.
        anchor.revealing = occurrence.id
        revealed = occurrence.id
        revealRequest += 1
        expand(occurrence)
    }

    private func scrollToRevealed(with proxy: ScrollViewProxy) {
        guard let id = revealed else { return }
        revealed = nil
        // Once the update is laid out: a card that left above it would move it after.
        Task {
            withAnimation(animation) {
                proxy.scrollTo(id, anchor: .top)
            }
            anchor.revealing = nil  // Where it's scrolled to is where it's held from now on.
        }
    }
}
