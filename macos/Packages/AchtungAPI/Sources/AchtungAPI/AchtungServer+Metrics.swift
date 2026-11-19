import AchtungDomain
import Foundation

// The graphs in an alert's details (ADR 0026): the server queries the instance's metrics
// backend; the client names the occurrence and the panel.

extension AchtungServer {
    /// The panel's graph for the occurrence now. `.notFound` when the occurrence is gone or
    /// has no such graph any more; `.metricsFailed` when the metrics backend failed.
    public func metricGraph(occurrenceID id: Int, panel: MetricPanel) async throws(ServerError)
        -> MetricGraph
    {
        try await call {
            let output = try await client.getOccurrenceMetrics(
                path: .init(id: id, panel: panel.pathValue))
            switch output {
            case .ok(let response):
                return try response.body.json.domain()
            case .badRequest(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .notFound(let response):
                throw ServerError.notFound(try response.body.json.error)
            case .badGateway(let response):
                throw ServerError.metricsFailed(try response.body.json.error)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
    }
}

extension MetricPanel {
    fileprivate var pathValue: Operations.GetOccurrenceMetrics.Input.Path.PanelPayload {
        switch self {
        case .podCPU: .podCpu
        }
    }
}

extension Components.Schemas.MetricGraph {
    func domain() throws -> MetricGraph {
        guard let panel = MetricPanel(rawValue: panel) else {
            throw ServerError.invalidResponse("Unknown graph \(panel)")
        }
        return MetricGraph(
            panel: panel,
            unit: unit.domain,
            start: from,
            end: to,
            step: TimeInterval(stepSeconds),
            series: series.map { series in
                MetricGraph.Series(
                    name: series.name, role: series.role.domain,
                    points: series.points.map { MetricGraph.Point(time: $0.at, value: $0.value) })
            },
            truncated: truncated)
    }
}

extension Components.Schemas.MetricGraph.UnitPayload {
    fileprivate var domain: MetricGraph.Unit {
        switch self {
        case .cores: .cores
        }
    }
}

extension Components.Schemas.MetricGraph.SeriesPayloadPayload.RolePayload {
    fileprivate var domain: MetricGraph.Role {
        switch self {
        case .usage: .usage
        case .request: .request
        case .limit: .limit
        }
    }
}
