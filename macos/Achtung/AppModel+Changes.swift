import AchtungAPI
import AchtungDomain
import AppKit

// What the server's change stream (ADR 0019) makes the app read again.
extension AppModel {
    func startChangeStream(for inbox: InboxModel) {
        let stream = ChangeStream(server: inbox.server) { [weak self, weak inbox] changes in
            guard let self, let inbox, inbox === self.inbox else { return }
            reread(changes, in: inbox)
        }
        changeStream = stream
        stream.start()
    }

    /// Occurrences and silences: the inbox, which posts notifications as a poll does. Any
    /// change: Home and an Alertmanager's detail, if shown, follow their notifications;
    /// settings also re-read the ignored alert names, as a save would.
    private func reread(_ changes: Set<ServerChange>, in inbox: InboxModel) {
        let server = ["baseURL": inbox.baseURL]
        // One notification: Home and a detail reload on either, so both would read twice.
        if changes.contains(.settings) {
            NotificationCenter.default.post(
                name: .ignoredAlertNamesChanged, object: nil, userInfo: server)
        } else {
            NotificationCenter.default.post(name: .alertsChanged, object: nil, userInfo: server)
        }
        if changes.contains(.occurrences) || changes.contains(.silences) {
            requestRefresh(of: inbox)
        } else if changes.contains(.settings) {
            Task { await refreshIgnoredNames() }
        }
    }

    /// The ignored alert names when they're due, then the inbox: the list on screen too. The
    /// poll's refresh, and the stream's.
    private func refresh(_ inbox: InboxModel) async {
        await refreshIgnoredNames()
        let scope = inbox.activeScope
        await inbox.refresh(scope, visiting: NSApp.isActive && scope != nil)
    }

    /// One refresh at a time, for the stream and the poll: one asked for during another
    /// runs once it's done.
    func requestRefresh(of inbox: InboxModel) {
        guard refreshing == nil else {
            refreshAgain = true
            return
        }
        refreshing = Task { [weak self] in
            repeat {
                self?.refreshAgain = false
                await self?.refresh(inbox)
            } while self?.refreshAgain == true && !Task.isCancelled
            if !Task.isCancelled {
                self?.refreshing = nil
            }
        }
    }
}
