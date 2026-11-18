import AchtungDomain
import SwiftUI

// Live's keyboard: ↑ and ↓ move between cards, Return and Space open and close the one the
// keyboard is on, and Esc goes back to the latest.
extension LiveStream {
    /// Moves the keyboard to the next or previous card, from the expanded one if it hasn't
    /// moved yet, and scrolls just enough to show it.
    func moveKeyboard(by step: Int, with proxy: ScrollViewProxy) -> KeyPress.Result {
        let order = order
        guard let last = order.indices.last else { return .ignored }
        let target =
            if let current = (keyboardCard ?? kept).flatMap({ order.firstIndex(of: $0) }) {
                order[min(max(current + step, 0), last)]
            } else {
                step > 0 ? order[0] : order[last]
            }
        keyboardCard = target
        withAnimation(animation) { proxy.scrollTo(target) }
        return .handled
    }

    /// Return and Space expand the card the keyboard is on, scrolled to the top, or collapse
    /// it if it's expanded. A card that leaves the stream as it collapses hands the keyboard
    /// to the next one.
    func toggleKeyboardCard() -> KeyPress.Result {
        guard let id = keyboardCard ?? kept, order.contains(id),
            let occurrence = shown.first(where: { $0.id == id })
        else { return .ignored }
        keyboardCard = id
        if kept == id {
            collapseHandingOnKeyboard()
        } else {
            reveal(occurrence)
        }
        return .handled
    }

    /// Collapses the expanded card. When the keyboard is on it and it leaves the stream as it
    /// collapses, the keyboard goes to the next one.
    func collapseHandingOnKeyboard() {
        let order = order
        if let id = kept, keyboardCard == id, let index = order.firstIndex(of: id),
            let occurrence = shown.first(where: { $0.id == id }),
            hidesRead && readState.isRead(occurrence)
        {
            let rest = order.filter { $0 != id }
            if !rest.isEmpty { keyboardCard = rest[min(index, rest.count - 1)] }
        }
        collapse()
    }

    /// Esc goes back to the latest while a card is open or highlighted; otherwise it's left
    /// to whatever else takes it.
    func escape() -> KeyPress.Result {
        guard kept != nil || highlighted != nil else { return .ignored }
        showLatest()
        return .handled
    }

    /// Back to the latest, as the stream is when the user comes to Live: nothing expanded or
    /// highlighted, so a read card opened from the timeline leaves again where read cards
    /// are hidden, and scrolled to the newest.
    func showLatest() {
        keyboardCard = nil
        highlighted = nil
        collapse()
        withAnimation(animation) { position.scrollTo(edge: .top) }
    }
}
