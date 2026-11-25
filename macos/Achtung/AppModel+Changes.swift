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
        // A handover this Mac asked for ended (ADR 0022): tell this Mac, and no other.
        inbox.handoverWatch.onEnded = { [weak self, weak inbox] handover, alertTitle in
            guard let self, let inbox, inbox === self.inbox else { return }
            // Like an alert's notification: not while notifications are off or paused.
            let defaults = UserDefaults.standard
            guard NotificationSetting.isOn(in: defaults, at: .now),
                defaults.object(forKey: NotificationSetting.handoversKey) as? Bool ?? true
            else { return }
            notifier.post(ended: handover, alertTitle: alertTitle, server: inbox.baseURL)
        }
    }

    /// Occurrences and silences: the inbox, which posts notifications as a poll does. Any
    /// change: Home and an Alertmanager's detail, if shown, follow their notifications;
    /// settings also re-read the ignored alert names, as a save would.
    private func reread(_ changes: Set<ServerChange>, in inbox: InboxModel) {
        let server = ["baseURL": inbox.baseURL]
        // Handovers concern only the open alert and this Mac's own (ADR 0022).
        if changes.contains(.handovers) {
            Task { await inbox.handoversChanged() }
        }
        // One notification: Home and a detail reload on either, so both would read twice.
        if changes.contains(.settings) {
            NotificationCenter.default.post(
                name: .ignoredAlertNamesChanged, object: nil, userInfo: server)
        } else if changes != [.handovers] {
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
        // Without the stream, or for what it missed: handovers still moving are read too.
        if inbox.followsHandovers {
            await inbox.handoversChanged()
        }
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
