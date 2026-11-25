import AchtungDomain
import Foundation
import Testing

private let start = Date(timeIntervalSince1970: 1_793_000_000)

private func handover(
    _ id: Int, _ state: Handover.State, action: String = "investigate",
    progress: [Handover.Progress] = []
) -> Handover {
    Handover(
        id: id, occurrenceID: 42, handler: "herdr-agent", handlerName: "herdr agent",
        handlerVersion: "0.1.0", action: action, title: "Investigate with Agent",
        requestedAt: start, state: state, progress: progress)
}

private func offer(_ action: String, handler: String = "herdr-agent") -> ActionOffer {
    ActionOffer(
        handler: handler, handlerName: "herdr agent", action: action, title: action,
        description: "", isAvailable: true, lastSeenAt: start)
}

private let later = start.addingTimeInterval(60)
private let running = Handover.State.running(claimedAt: start, deadlineAt: later)
private let cancelled = Handover.State.cancelled(claimedAt: nil, finishedAt: later)
private let succeeded = Handover.State.succeeded(
    claimedAt: start, finishedAt: later, .init(summary: "Out of memory", body: "Details"))

private func detail(_ handovers: [Handover]) -> OccurrenceDetail {
    let alert = IncomingAlert(
        sourceKey: "3f9c2e1a", severity: .critical, title: "CardAuthorisationsFailing",
        summary: nil, labels: [:], annotations: [:], startsAt: start, links: [], state: .firing)
    let occurrence = Occurrence(
        id: 42, channel: ChannelID(instance: "eu-prod", slug: "payments"), source: "alertmanager",
        alert: alert, firstReceivedAt: start, lastReceivedAt: start, lastEventAt: start,
        lastEventKind: .fired, notificationCount: 1)
    return OccurrenceDetail(
        occurrence: occurrence, events: [], otherOccurrences: [], handovers: handovers)
}

@Test func onlyARequestedOrRunningHandoverIsActive() {
    #expect(handover(1, .requested).isActive)
    #expect(handover(1, running).isActive)
    #expect(!handover(1, succeeded).isActive)
    #expect(!handover(1, cancelled).isActive)
    #expect(!handover(1, .expired(finishedAt: later)).isActive)
}

@Test func theNewestHandoverOfEachActionHasACardAndTheRestAreEarlier() {
    let shown = detail([
        handover(5, running), handover(4, succeeded, action: "explain"), handover(3, cancelled),
        handover(2, cancelled, action: "explain"), handover(1, succeeded),
    ])

    #expect(shown.latestHandovers.map(\.id) == [5, 4])
    #expect(shown.earlierHandovers.map(\.id) == [3, 2, 1])
}

@Test func anActionsActiveHandoverIsFoundByHandlerAndAction() {
    let shown = detail([handover(2, running), handover(1, succeeded, action: "explain")])

    #expect(shown.activeHandover(of: offer("investigate"))?.id == 2)
    #expect(shown.activeHandover(of: offer("explain")) == nil)
    #expect(shown.activeHandover(of: offer("investigate", handler: "another")) == nil)
}

@Test func itKnowsWhenAHandlerTookItAndWhenItEnded() {
    #expect(handover(1, .requested).claimedAt == nil)
    #expect(handover(1, .requested).finishedAt == nil)
    #expect(handover(1, running).claimedAt == start)
    #expect(handover(1, running).finishedAt == nil)
    #expect(handover(1, cancelled).claimedAt == nil)
    #expect(handover(1, cancelled).finishedAt == later)
    #expect(handover(1, .timedOut(claimedAt: start, finishedAt: later)).finishedAt == later)
}

@Test func theStatusLineSaysWhereItIs() {
    let working = handover(
        1, running,
        progress: [
            .init(reportedAt: start, message: "started"),
            .init(reportedAt: later, message: "reading logs"),
        ])

    #expect(handover(1, .requested).statusLine == "Waiting for herdr agent…")
    #expect(handover(1, running).statusLine == "herdr agent is working on it…")
    #expect(working.statusLine == "reading logs")
    #expect(handover(1, succeeded).statusLine == "Out of memory")
    #expect(
        handover(1, .failed(claimedAt: start, finishedAt: later, error: "No access")).statusLine
            == "No access")
    #expect(handover(1, cancelled).statusLine == "Cancelled")
    #expect(
        handover(1, .timedOut(claimedAt: start, finishedAt: later)).statusLine
            == "herdr agent didn't finish in time")
    #expect(handover(1, .expired(finishedAt: later)).statusLine == "herdr agent didn't take it")
}
