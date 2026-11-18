import AchtungDomain
import SwiftUI

// Where the window goes: the list on screen, the sidebar's selection, alerts opened from a
// notification, the menu bar or a search, and the first unread alert of a channel just
// opened.
extension InboxView {
    /// The list on screen: the search, else the selected list.
    var shownScope: OccurrenceScope? {
        activeSearch.map { .search($0) } ?? selectedScope
    }

    /// The alert whose detail is on screen: a channel's selected one, unless a search
    /// covers it. Live and the lists themselves don't count: a row may be out of sight.
    var viewedOccurrenceID: Int? {
        guard activeSearch == nil, case .channel = selectedScope else { return nil }
        return selectedOccurrence?.id
    }

    /// The sidebar's selection; choosing a row, even the one selected, ends a search.
    var sidebarSelection: Binding<InboxPage?> {
        Binding {
            page
        } set: {
            show($0)
            query = SearchQuery()
        }
    }

    /// Goes to `page`. Choosing Live while it's shown goes back to its latest, also when a
    /// search covers it and no stream is there to hear the request: its card collapses here.
    func show(_ page: InboxPage?) {
        if page == .list(.allChannels), self.page == page {
            liveKept = nil
            liveLatestRequest += 1
        }
        self.page = page
    }

    /// Shows an occurrence in its channel, selected even if its list doesn't hold it: from
    /// Home, an Alertmanager's detail, a notification or the menu bar.
    func openFromHome(_ occurrence: Occurrence) {
        revealed = occurrence
        page = .list(.channel(occurrence.channel))
    }

    func takeOpenRequest() {
        guard let request = model.openRequest else { return }
        model.openRequest = nil
        query = SearchQuery()  // Going somewhere ends a search.
        switch request {
        case .occurrence(let occurrence):
            openFromHome(occurrence)
            selectedID = occurrence.id
        case .list(let scope):
            show(.list(scope))
        }
    }

    func selectFirstUnread() {
        guard let scope = selectFirstUnreadIn, scope == selectedScope,
            let occurrences = model.shownOccurrences(in: scope, keeping: nil)
        else { return }
        // Once, on opening the channel: selecting marks it read, and with read alerts
        // hidden, selecting the next unread one each time would read the whole list.
        selectedID = model.readState.firstUnread(in: occurrences)?.id
        selectFirstUnreadIn = nil
    }
}
