import AchtungDomain
import Foundation
import Testing

private let infra = ChannelID(instance: "onprem", slug: "infra")

/// An occurrence of the alert `key`, started and changed at minutes after the fixture's
/// start, resolved at `resolved` if given.
private func occurrence(
    id: Int, key: String = "flapping", title: String = "VolumeHigh",
    channel: ChannelID = infra, started: Double, resolved: Double? = nil,
    lastEvent: Double? = nil, kind: OccurrenceEvent.Kind? = nil, remindAt: Double? = nil
) -> Occurrence {
    let state: AlertState = resolved.map { .resolved(endsAt: Fixture.minutes($0)) } ?? .firing
    let lastEventAt = Fixture.minutes(lastEvent ?? resolved ?? started)
    return Occurrence(
        id: id, channel: channel, source: "alertmanager",
        alert: IncomingAlert(
            sourceKey: key, severity: .warning, title: title, summary: nil,
            labels: [:], annotations: [:], startsAt: Fixture.minutes(started), links: [],
            state: state),
        firstReceivedAt: Fixture.minutes(started), lastReceivedAt: lastEventAt,
        lastEventAt: lastEventAt, lastEventKind: kind ?? (resolved == nil ? .fired : .resolved),
        notificationCount: 1, remindAt: remindAt.map(Fixture.minutes))
}

/// Shows read alerts too, so `shown` is everything.
private func showingRead() -> ReadState {
    var state = ReadState()
    state.setHidesRead(false, in: .allChannels)
    return state
}

@Test func anAlertsOccurrencesFoldIntoOneCardShowingTheLatest() {
    let feed = [
        occurrence(id: 3, started: 30),
        occurrence(id: 2, started: 20, resolved: 25),
        occurrence(id: 1, started: 10, resolved: 15),
    ]

    let alerts = LiveAlert.fold(feed, loadedSince: nil)

    #expect(alerts.count == 1)
    #expect(alerts[0].latest.id == 3)
    #expect(alerts[0].earlier.map(\.id) == [2, 1])
    #expect(alerts[0].occurrences.count == 3)
    #expect(alerts[0].since == Fixture.minutes(10))
    #expect(alerts[0].isCountComplete)
}

@Test func theSameNameWithOtherLabelsIsAnotherAlert() {
    // Alertmanager's fingerprint differs with the labels; the title doesn't decide.
    let feed = [
        occurrence(id: 1, key: "fingerprint-a", title: "KeycloakDown", started: 10),
        occurrence(id: 2, key: "fingerprint-b", title: "KeycloakDown", started: 20),
    ]

    let alerts = LiveAlert.fold(feed, loadedSince: nil)

    #expect(alerts.map(\.latest.id) == [2, 1])
}

@Test func theSameKeyInAnotherChannelOrInstanceIsAnotherAlert() {
    let feed = [
        occurrence(id: 1, started: 10),
        occurrence(id: 2, channel: ChannelID(instance: "cloud", slug: "infra"), started: 20),
        occurrence(id: 3, channel: ChannelID(instance: "onprem", slug: "apps"), started: 30),
    ]

    #expect(LiveAlert.fold(feed, loadedSince: nil).count == 3)
}

@Test func aChangeToAnyOccurrenceMovesTheCardToTheTop() {
    let quiet = occurrence(id: 1, key: "quiet", started: 40)
    var feed = OccurrenceList()
    feed.merge([
        quiet,
        occurrence(id: 3, started: 30, resolved: 35),
        occurrence(id: 2, started: 10, resolved: 15),
    ])
    #expect(LiveAlert.fold(feed.occurrences, loadedSince: nil).map(\.latest.id) == [1, 3])

    // A new firing of the flapping alert: its card goes to the top, no card is added.
    feed.merge([occurrence(id: 4, started: 50)])
    let afterFiring = LiveAlert.fold(feed.occurrences, loadedSince: nil)
    #expect(afterFiring.map(\.latest.id) == [4, 1])
    #expect(afterFiring[0].occurrences.count == 3)

    // A reminder coming due on an older occurrence moves it too, still showing the latest.
    feed.merge([occurrence(id: 2, started: 10, resolved: 15, lastEvent: 60, kind: .reminded)])
    let afterReminder = LiveAlert.fold(feed.occurrences, loadedSince: nil)
    #expect(afterReminder.map(\.latest.id) == [4, 1])
    #expect(afterReminder[0].lastEventAt == Fixture.minutes(60))
}

@Test func anUpdateToAFoldedOccurrenceUpdatesItsCardInPlace() {
    var feed = OccurrenceList()
    feed.merge([occurrence(id: 2, started: 20), occurrence(id: 1, started: 10, resolved: 15)])
    let before = LiveAlert.fold(feed.occurrences, loadedSince: nil)

    feed.merge([occurrence(id: 2, started: 20, resolved: 25)])
    let after = LiveAlert.fold(feed.occurrences, loadedSince: nil)

    #expect(after.map(\.id) == before.map(\.id))
    #expect(after[0].latest.alert.state == .resolved(endsAt: Fixture.minutes(25)))
    #expect(after[0].occurrences.count == 2)
}

@Test func oneUnreadOccurrenceMakesTheCardUnreadAndMarkingItReadsThemAll() {
    var state = ReadState()
    let older = occurrence(id: 1, started: 10, resolved: 15)
    let latest = occurrence(id: 2, started: 20)
    state.markRead(latest)
    let alert = LiveAlert.fold([latest, older], loadedSince: nil)[0]
    #expect(!alert.isRead(in: state))
    #expect(alert.lastUnread(in: state)?.id == 1)

    for occurrence in alert.occurrences {
        state.markRead(occurrence)
    }

    #expect(alert.isRead(in: state))
    #expect(alert.lastUnread(in: state) == nil)
}

@Test func theCardsUnreadMarkComesFromItsLastChangedUnreadOccurrence() {
    let state = ReadState()
    let resent = occurrence(id: 2, started: 20, lastEvent: 90, kind: .resent)
    let alert = LiveAlert.fold(
        [resent, occurrence(id: 1, started: 10, resolved: 15)], loadedSince: nil)[0]

    #expect(alert.lastUnread(in: state)?.isResent == true)
}

@Test func withReadHiddenACardWithAnythingUnreadStaysWithItsWholeHistory() {
    var state = ReadState()
    let read = occurrence(id: 1, key: "read", started: 5)
    let readLatest = occurrence(id: 3, started: 30)
    let unreadOlder = occurrence(id: 2, started: 20, resolved: 25)
    state.markRead(read)
    state.markRead(readLatest)
    let alerts = LiveAlert.fold([readLatest, unreadOlder, read], loadedSince: nil)

    let shown = LiveAlert.shown(alerts, readState: state, keeping: nil)

    #expect(shown.map(\.latest.id) == [3])
    #expect(shown[0].earlier.map(\.id) == [2])
}

@Test func withReadHiddenTheOpenCardStaysOnceRead() {
    var state = ReadState()
    let alerts = LiveAlert.fold(
        [occurrence(id: 2, started: 20), occurrence(id: 1, started: 10, resolved: 15)],
        loadedSince: nil)
    for occurrence in alerts[0].occurrences {
        state.markRead(occurrence)
    }

    #expect(LiveAlert.shown(alerts, readState: state, keeping: alerts[0].id).count == 1)
    #expect(LiveAlert.shown(alerts, readState: state, keeping: nil).isEmpty)
    #expect(LiveAlert.shown(alerts, readState: showingRead(), keeping: nil).count == 1)
}

@Test func aCountReachingPastWhatIsLoadedIsNotComplete() {
    // Loaded back to minute 30. The occurrence that started at 10 is loaded because it
    // changed at 60 (a reminder); one that started and ended between 10 and 30 isn't.
    let feed = [
        occurrence(id: 3, started: 40, resolved: 45),
        occurrence(id: 1, started: 10, resolved: 15, lastEvent: 60, kind: .reminded),
        occurrence(id: 4, key: "recent", started: 35, resolved: 50),
    ]

    let alerts = LiveAlert.fold(feed, loadedSince: Fixture.minutes(30))

    #expect(alerts.first { $0.latest.id == 3 }?.isCountComplete == false)
    #expect(alerts.first { $0.latest.id == 4 }?.isCountComplete == true)
}

@Test func pendingRemindersOnEarlierOccurrencesStayInView() {
    let alert = LiveAlert.fold(
        [
            occurrence(id: 3, started: 30, remindAt: 500),
            occurrence(id: 2, started: 20, resolved: 25, remindAt: 300),
            occurrence(id: 1, started: 10, resolved: 15, remindAt: 200),
        ], loadedSince: nil)[0]

    #expect(alert.earlierReminders.map(\.id) == [1, 2])
}

@Test func theNewDividerSplitsCardsByTheirLastChange() {
    var state = ReadState()
    state.markSeen(upTo: Fixture.minutes(50))
    let alerts = LiveAlert.fold(
        [
            occurrence(id: 3, started: 60),
            occurrence(id: 2, key: "older", started: 40),
            occurrence(id: 1, started: 10, resolved: 15),
        ], loadedSince: nil)

    let order = state.newFirst(alerts)

    #expect(order.new.map(\.latest.id) == [3])
    #expect(order.earlier.map(\.latest.id) == [2])
}

@Test func aTimelineClusterCountsOccurrencesOfOneAlertAsOneAlert() {
    let window = TimelineWindow(endingAt: Fixture.minutes(60))
    let timeline = Timeline(
        occurrences: [
            occurrence(id: 2, started: 30), occurrence(id: 1, started: 28, resolved: 29),
        ],
        readState: ReadState(), window: window)

    let clusters = timeline.clusters(gap: 0.01)

    #expect(clusters.map(\.count) == [3])
    #expect(clusters.map(\.alertCount) == [1])
}
