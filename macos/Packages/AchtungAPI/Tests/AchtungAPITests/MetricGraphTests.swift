import AchtungDomain
import Foundation
import Testing

@testable import AchtungAPI

/// The graphs in an alert's details (ADR 0026).
@Test func anOccurrencesDetailListsTheGraphsThisClientKnows() async throws {
    let transport = StubTransport(routes: [
        "/api/occurrences/9": .init(status: 200, fixture: "occurrence-with-graphs")
    ])
    let detail = try await AchtungServer(baseURL: URL(filePath: "/"), transport: transport)
        .occurrence(id: 9)

    // "pod-memory" is a panel of a newer server: left out, not an error.
    #expect(detail.metricPanels == [.podCPU])
}

@Test func aServerBeforeGraphsListsNone() async throws {
    let transport = StubTransport(routes: [
        "/api/occurrences/9": .init(status: 200, fixture: "occurrence-9")
    ])
    let detail = try await AchtungServer(baseURL: URL(filePath: "/"), transport: transport)
        .occurrence(id: 9)

    #expect(detail.metricPanels.isEmpty)
}

private func server(_ status: Int, _ fixture: String, log: RequestLog? = nil) -> AchtungServer {
    AchtungServer(
        baseURL: URL(filePath: "/"),
        transport: StubTransport(
            routes: ["/api/occurrences/9/metrics/pod-cpu": .init(status: status, fixture: fixture)],
            log: log))
}

@Test func mapsAGraphsSeriesInTheServersOrder() async throws {
    let log = RequestLog()
    let graph = try await server(200, "metric-graph", log: log)
        .metricGraph(occurrenceID: 9, panel: .podCPU)

    #expect(await log.paths == ["/api/occurrences/9/metrics/pod-cpu"])
    #expect(graph.panel == .podCPU)
    #expect(graph.unit == .cores)
    #expect(graph.start == Date(timeIntervalSince1970: 1_794_067_200))
    #expect(graph.end == graph.start.addingTimeInterval(3 * 3600))
    #expect(graph.step == 60)
    #expect(graph.series.map(\.name) == ["api", "api", "api", "istio-proxy"])
    #expect(graph.series.map(\.role) == [.usage, .request, .limit, .usage])
    #expect(graph.series.first?.points.map(\.value) == [0.212, 0.248, 0.31])
    #expect(graph.usage.map(\.name) == ["api", "istio-proxy"])
    #expect(!graph.truncated)
}

@Test func anOccurrenceWithoutTheGraphIsNotFound() async {
    await #expect(throws: ServerError.notFound("The occurrence has no such graph")) {
        try await server(404, "metric-graph-none").metricGraph(occurrenceID: 9, panel: .podCPU)
    }
}

@Test func aFailedMetricsBackendIsItsOwnError() async {
    await #expect(throws: ServerError.metricsFailed("the metrics backend answered 503")) {
        try await server(502, "metric-graph-failed").metricGraph(occurrenceID: 9, panel: .podCPU)
    }
}
