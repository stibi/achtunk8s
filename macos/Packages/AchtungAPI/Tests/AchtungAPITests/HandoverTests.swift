import AchtungDomain
import Foundation
import Testing

@testable import AchtungAPI

// Handing an alert over to a plugin (ADR 0022): the actions offered, the handovers, and
// asking for and cancelling one.

private func server(_ routes: [String: StubTransport.Route], log: RequestLog? = nil)
    -> AchtungServer
{
    AchtungServer(
        baseURL: URL(filePath: "/"), transport: StubTransport(routes: routes, log: log))
}

private func at(_ time: String) -> Date {
    (try? Date("2026-11-15T\(time)Z", strategy: .iso8601)) ?? .distantPast
}

private let investigate = ActionOffer(
    handler: "herdr-agent", handlerName: "herdr agent", action: "investigate",
    title: "Investigate with Agent", description: "Starts an agent, read-only.",
    isAvailable: true, lastSeenAt: at("10:00:10"))

@Test func mapsTheActionsOfferedAndEachHandoverWithTheFactsItsStateHas() async throws {
    let dashboard = try #require(URL(string: "https://grafana.example.com/d/memory"))
    let detail = try await server([
        "/api/occurrences/9": .init(status: 200, fixture: "occurrence-with-handovers")
    ]).occurrence(id: 9)

    #expect(detail.actions.first == investigate)
    #expect(detail.actions.map(\.isAvailable) == [true, false])
    #expect(
        detail.handovers.map(\.state) == [
            .running(claimedAt: at("10:00:02"), deadlineAt: at("10:20:02")),
            .succeeded(
                claimedAt: at("09:00:03"), finishedAt: at("09:07:00"),
                .init(
                    summary: "The api container is out of memory",
                    body: "## Findings\n\nOOM-killed four times.",
                    links: [
                        .init(title: "Memory dashboard", url: dashboard)
                    ])),
            .failed(
                claimedAt: at("08:00:01"), finishedAt: at("08:00:09"),
                error: "The model didn't answer"),
            .cancelled(claimedAt: nil, finishedAt: at("07:00:30")),
            .timedOut(claimedAt: at("06:00:01"), finishedAt: at("06:15:01")),
            .expired(finishedAt: at("05:10:00")),
            .requested,
        ])
    #expect(
        detail.handovers.first?.progress == [
            .init(reportedAt: at("10:00:05"), message: "agent inv-4 started")
        ])
    #expect(detail.handovers.first?.handlerVersion == "0.1.0")
}

@Test func aDetailFromAServerBeforeHandoversHasNone() async throws {
    let detail = try await server([
        "/api/occurrences/9": .init(status: 200, fixture: "occurrence-9")
    ])
    .occurrence(id: 9)

    #expect(detail.actions.isEmpty)
    #expect(detail.handovers.isEmpty)
}

@Test func handingOverNamesTheHandlerAndActionAndReturnsTheHandover() async throws {
    let log = RequestLog()
    let handover = try await server(
        ["/api/occurrences/9/handovers": .init(status: 201, fixture: "handover-requested")],
        log: log
    ).handOver(occurrenceID: 9, to: investigate)

    #expect(handover.id == 5)
    #expect(handover.state == .requested)
    #expect(await log.bodies.first?.contains("herdr-agent") == true)
    #expect(await log.bodies.first?.contains("investigate") == true)
}

@Test func theOneAlreadyRunningIsReturnedAsItIs() async throws {
    let handover = try await server([
        "/api/occurrences/9/handovers": .init(status: 200, fixture: "handover-requested")
    ]).handOver(occurrenceID: 9, to: investigate)

    #expect(handover.id == 5)
}

@Test func aHandlerThatIsntConnectedIsTheServersReason() async {
    await #expect(throws: ServerError.rejected("herdr agent isn't connected")) {
        try await server([
            "/api/occurrences/9/handovers": .init(status: 409, fixture: "handover-not-connected")
        ]).handOver(occurrenceID: 9, to: investigate)
    }
}

@Test func tooManyHandoversIsTheServersReasonToo() async {
    await #expect(throws: ServerError.rejected("herdr agent isn't connected")) {
        try await server([
            "/api/occurrences/9/handovers": .init(status: 503, fixture: "handover-not-connected")
        ]).handOver(occurrenceID: 9, to: investigate)
    }
}

/// A server from before handovers answers 404 for the path, in its framework's words.
@Test func aServerWithoutHandoversSaysSoInsteadOfFailingToParse() async {
    await #expect(
        throws: ServerError.notFound(
            "The server doesn't have this, or is older than this app and can't hand alerts "
                + "over yet."
        )
    ) {
        try await server([
            "/api/occurrences/9/handovers": .init(status: 404, fixture: "route-not-found")
        ]).handOver(occurrenceID: 9, to: investigate)
    }
}

@Test func cancellingReturnsTheHandoverCancelledWithWhenItWasClaimed() async throws {
    let handover = try await server([
        "/api/handovers/4/cancel": .init(status: 200, fixture: "handover-cancelled")
    ]).cancelHandover(id: 4)

    #expect(handover.state == .cancelled(claimedAt: at("10:00:02"), finishedAt: at("10:01:00")))
    #expect(!handover.isActive)
}

@Test func cancellingOneThatEndedIsTheServersReason() async {
    await #expect(throws: ServerError.rejected("The handover is succeeded already")) {
        try await server(["/api/handovers/4/cancel": .init(status: 409, fixture: "handover-ended")])
            .cancelHandover(id: 4)
    }
}

@Test func readsOneHandover() async throws {
    let handover = try await server([
        "/api/handovers/5": .init(status: 200, fixture: "handover-requested")
    ]).handover(id: 5)

    #expect(handover.occurrenceID == 9)
}

@Test(arguments: [
    ("handover-running-unclaimed", "Handover 6 is running without claimedAt"),
    ("handover-succeeded-no-summary", "Handover 7 is succeeded without summary"),
    ("handover-script-link", "A handover's link is not a web URL: javascript:alert(1)"),
])
func aHandoverItsStateDoesntAllowIsAnInvalidResponse(fixture: String, message: String) async {
    await #expect(throws: ServerError.invalidResponse(message)) {
        try await server(["/api/handovers/5": .init(status: 200, fixture: fixture)])
            .handover(id: 5)
    }
}
