import AchtungDomain
import Foundation
import Testing

@testable import AchtungAPI

/// Reminders in an occurrence's history (ADR 0025): set, cancelled and come due.
@Test func mapsReminderEventsAndAReminderThatCameDue() async throws {
    let transport = StubTransport(routes: [
        "/api/occurrences/9": .init(status: 200, fixture: "occurrence-reminded")
    ])
    let detail = try await AchtungServer(baseURL: URL(filePath: "/"), transport: transport)
        .occurrence(id: 9)

    #expect(
        detail.events.map(\.kind) == [
            .fired, .reminderSet, .reminderCancelled, .reminderSet, .resolved, .reminded,
        ])
    #expect(
        detail.events.map(\.remindAt) == [
            nil, Date(timeIntervalSince1970: 1_794_117_600), nil,
            Date(timeIntervalSince1970: 1_794_121_200), nil, nil,
        ])
    #expect(detail.occurrence.lastEventKind == .reminded)
    #expect(!detail.occurrence.alert.isFiring)
}

private func server(_ status: Int, _ fixture: String, log: RequestLog? = nil) -> AchtungServer {
    AchtungServer(
        baseURL: URL(filePath: "/"),
        transport: StubTransport(
            routes: ["/api/occurrences/4/reminder": .init(status: status, fixture: fixture)],
            log: log))
}

@Test func settingAReminderSendsTheInstantAndReturnsTheOccurrenceWithIt() async throws {
    let log = RequestLog()
    let due = Date(timeIntervalSince1970: 1_795_071_600)  // 2026-11-19T07:00:00Z
    let occurrence = try await server(200, "reminder-set", log: log)
        .remind(occurrenceID: 4, at: due)

    #expect(occurrence.remindAt == due)
    #expect(await log.bodies.count == 1)
    #expect(await log.bodies.first?.contains("\"2026-11-19T07:00:00") == true)
}

@Test func cancellingAReminderReturnsTheOccurrenceWithoutOne() async throws {
    let occurrence = try await server(200, "reminder-cancelled").cancelReminder(occurrenceID: 4)

    #expect(occurrence.remindAt == nil)
}

@Test func aTimeTheServerRefusesIsItsMessage() async {
    await #expect(throws: ServerError.rejected("A reminder must be in the future")) {
        try await server(400, "reminder-past").remind(occurrenceID: 4, at: .distantPast)
    }
}

/// A server from before reminders answers 404 for the path, in its framework's words.
@Test func aServerWithoutRemindersSaysSoInsteadOfFailingToParse() async {
    for call in [
        { try await server(404, "route-not-found").remind(occurrenceID: 4, at: .now) },
        { try await server(404, "route-not-found").cancelReminder(occurrenceID: 4) },
    ] {
        do {
            _ = try await call()
            Issue.record("expected a failure")
        } catch ServerError.notFound(let message) {
            #expect(message.contains("older than this app"))
        } catch {
            Issue.record("unexpected \(error)")
        }
    }
}

/// An occurrence from a server without reminders has no `remindAt` at all.
@Test func anOccurrenceFromAServerWithoutRemindersHasNone() async throws {
    let occurrence = try await AchtungServer(
        baseURL: URL(filePath: "/"),
        transport: StubTransport(routes: [
            "/api/occurrences/4/silence": .init(status: 200, fixture: "silence-ok")
        ])
    ).silence(occurrenceID: 4, for: .oneHour)

    #expect(occurrence.remindAt == nil)
}
