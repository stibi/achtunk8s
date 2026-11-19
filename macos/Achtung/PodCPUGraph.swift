import AchtungAPI
import AchtungDomain
import SwiftUI

/// The CPU of the alert's pod, per container, in a card under the alert's summary and
/// actions: the last 3 hours of a firing alert, the hours around a resolved one, with the
/// alert's span shaded, the container's request and limit as dashed lines, and where the
/// samples stop when the pod is gone. Hovering shows each container's value at that time.
/// The plot keeps its height whether it's loading, empty, failed or drawn, so nothing
/// below it moves. While the alert fires and the app is active, it reloads every minute.
struct PodCPUGraph: View {
    static let plotHeight: CGFloat = 180
    private static let refreshInterval: Duration = .seconds(60)

    let occurrence: Occurrence
    let load: GraphLoad?
    let reload: () async -> Void

    @Environment(\.appearsActive) private var appearsActive

    private var current: GraphLoad? {
        load?.occurrenceID == occurrence.id && load?.panel == .podCPU ? load : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            GraphHeader(occurrence: occurrence, load: current)
            plot
                .frame(height: Self.plotHeight)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .paneCard()
        .task(id: [occurrence.id, occurrence.alert.isFiring, appearsActive] as [AnyHashable]) {
            // In the background, only a first load: no timer while nobody looks.
            guard appearsActive || current?.graph == nil else { return }
            await reload()
            while occurrence.alert.isFiring, appearsActive, !Task.isCancelled {
                try? await Task.sleep(for: Self.refreshInterval)
                guard !Task.isCancelled else { return }
                await reload()
            }
        }
    }

    @ViewBuilder private var plot: some View {
        if let graph = current?.graph {
            if graph.isEmpty {
                GraphMessage(
                    "No CPU data for this pod in this window", systemImage: "chart.xyaxis.line")
            } else {
                PodCPUChart(graph: graph, alert: occurrence.alert)
            }
        } else if let problem = current?.problem {
            GraphMessage(problem.detail, systemImage: "exclamationmark.triangle")
                .help(problem.title)
        } else {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

}

/// "CPU", the pod and the window on the left, the legend on the right; the legend wraps
/// below when the card is narrow.
private struct GraphHeader: View {
    let occurrence: Occurrence
    let load: GraphLoad?

    private var graph: MetricGraph? { load?.graph }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                title
                Spacer(minLength: 0)
                legend
            }
            VStack(alignment: .leading, spacing: 8) {
                title
                legend
            }
        }
    }

    private var title: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Label("CPU", systemImage: "cpu")
                    .font(.headline)
                // The graph stays; this says it's no longer current.
                if let problem = load?.problem, graph != nil {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                        .help("Not updated: \(problem.detail)")
                        .accessibilityLabel("Not updated: \(problem.detail)")
                }
            }
            Text(subtitle)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var subtitle: String {
        let pod = occurrence.alert.labels["pod"] ?? "Pod"
        guard let graph else { return pod }
        if occurrence.alert.isFiring {
            return "\(pod) · last 3 hours"
        }
        return "\(pod) · \(timeOrDate(graph.start)) – \(timeOrDate(graph.end))"
    }

    @ViewBuilder private var legend: some View {
        if let graph, !graph.isEmpty {
            let references = graph.references(alertContainer: occurrence.alert.labels["container"])
            FlowLayout(spacing: 12) {
                // A single container's name is in the subtitle's pod already.
                if graph.usage.count > 1 {
                    ForEach(Array(graph.usage.enumerated()), id: \.element.name) { index, series in
                        LegendItem(
                            name: series.name, color: ContainerPalette.color(index), dash: nil)
                    }
                }
                ForEach(references, id: \.role) { series in
                    LegendItem(
                        name: "\(series.role == .request ? "Request" : "Limit") "
                            + CPUFormat.value(series.points.last?.value ?? 0),
                        color: .secondary, dash: series.role.dash)
                }
                if graph.truncated {
                    Text("Busiest 10 containers")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        }
    }
}

private struct LegendItem: View {
    let name: String
    let color: Color
    let dash: [CGFloat]?

    var body: some View {
        HStack(spacing: 5) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 1))
                path.addLine(to: CGPoint(x: 14, y: 1))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: dash ?? []))
            .frame(width: 14, height: 2)
            Text(name)
                .foregroundStyle(.secondary)
        }
    }
}

/// A calm line in the plot's place: no data, or why it didn't load.
private struct GraphMessage: View {
    let text: String
    let systemImage: String

    init(_ text: String, systemImage: String) {
        self.text = text
        self.systemImage = systemImage
    }

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 8))
    }
}

/// One colour per container, in the server's order. No red or orange: those mean severity.
enum ContainerPalette {
    private static let colors: [Color] = [
        .blue, .teal, .purple, .indigo, .mint, .pink, .cyan, .brown, .green, .gray,
    ]

    static func color(_ index: Int) -> Color {
        colors[index % colors.count]
    }
}

extension MetricGraph.Role {
    /// Requests dotted, limits dashed: both quiet next to the usage.
    var dash: [CGFloat]? {
        switch self {
        case .usage: nil
        case .request: [2, 3]
        case .limit: [6, 3]
        }
    }
}
