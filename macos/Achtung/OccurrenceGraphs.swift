import AchtungAPI
import AchtungDomain
import Foundation

/// A graph of the open alert (ADR 0026), as last loaded: the graph, or why it didn't load.
struct GraphLoad: Equatable {
    let occurrenceID: Int
    let panel: MetricPanel
    var graph: MetricGraph?
    var problem: ServerError?
}

/// The open alert's graph, from the server, which queries the instance's metrics backend.
/// The inbox window makes one for its server, like Settings its `IgnoredAlertsModel`.
@Observable @MainActor
final class OccurrenceGraphs {
    /// The last graph loaded or loading; one at a time, for the alert in the detail pane.
    private(set) var load: GraphLoad?

    private let server: AchtungServer

    init(baseURL: URL) {
        server = AchtungServer(baseURL: baseURL)
    }

    /// Loads `panel` of `occurrence`. A reload of the same graph keeps what it had until the
    /// answer arrives, and keeps it when the reload fails, so the view doesn't flash empty.
    func load(_ panel: MetricPanel, of occurrence: Occurrence) async {
        if load?.occurrenceID != occurrence.id || load?.panel != panel {
            load = GraphLoad(occurrenceID: occurrence.id, panel: panel)
        }
        do throws(ServerError) {
            let graph = try await server.metricGraph(occurrenceID: occurrence.id, panel: panel)
            guard !Task.isCancelled, load?.occurrenceID == occurrence.id else { return }
            load = GraphLoad(occurrenceID: occurrence.id, panel: panel, graph: graph)
        } catch {
            guard !Task.isCancelled, load?.occurrenceID == occurrence.id else { return }
            load?.problem = error
        }
    }
}
