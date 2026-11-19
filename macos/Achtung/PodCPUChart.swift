import Accessibility
import AchtungDomain
import Charts
import SwiftUI

/// The plot of `PodCPUGraph`: each container's usage as a line over a soft area, the
/// references dashed, the alert's span shaded, and a crosshair with the values on hover.
struct PodCPUChart: View {
    let graph: MetricGraph
    let alert: IncomingAlert

    @State private var hovered: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var references: [MetricGraph.Series] {
        graph.references(alertContainer: alert.labels["container"])
    }

    private var axisTop: Double {
        graph.valueAxisTop(references: references)
    }

    /// The references within the axis; a limit far above it is in the legend only.
    private var drawnReferences: [MetricGraph.Series] {
        references.filter { ($0.points.map(\.value).max() ?? 0) <= axisTop }
    }

    var body: some View {
        Chart {
            alertSpan
            ForEach(Array(graph.usage.enumerated()), id: \.element.name) { index, series in
                usageMarks(series, color: ContainerPalette.color(index))
            }
            ForEach(drawnReferences, id: \.role) { series in
                referenceMarks(series)
            }
            if let endedAt = graph.endedAt {
                RuleMark(x: .value("Time", endedAt))
                    .foregroundStyle(.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [1, 3]))
                    .annotation(position: labelSide(endedAt), alignment: .top, spacing: 4) {
                        Text("No data after \(endedAt.formatted(date: .omitted, time: .shortened))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
            }
            if let hovered {
                hoverMarks(at: hovered)
            }
        }
        .chartXScale(domain: graph.start...graph.end)
        .chartYScale(domain: 0...axisTop)
        .chartXAxis {
            AxisMarks(values: graph.timeTicks()) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                AxisValueLabel(format: .dateTime.hour().minute())
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                AxisValueLabel {
                    if let cores = value.as(Double.self) {
                        Text(CPUFormat.axisLabel(cores, axisTop: axisTop))
                            .monospacedDigit()
                    }
                }
            }
        }
        .chartLegend(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(.rect)
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            hovered = hoverTime(at: location, proxy: proxy, geometry: geometry)
                        case .ended:
                            hovered = nil
                        }
                    }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: graph)
        .accessibilityChartDescriptor(PodCPUChartDescriptor(graph: graph, axisTop: axisTop))
        .accessibilityLabel("CPU of pod \(alert.labels["pod"] ?? "")")
    }

    /// A rule's label goes to its right, or to its left near the plot's right edge, so it
    /// stays inside the plot.
    private func labelSide(_ date: Date) -> AnnotationPosition {
        date.timeIntervalSince(graph.start) < graph.end.timeIntervalSince(graph.start) * 0.8
            ? .trailing : .leading
    }

    /// The time under the pointer, snapped to the step's points; nil outside the plot.
    private func hoverTime(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy)
        -> Date?
    {
        guard let frame = proxy.plotFrame else { return nil }
        let offset = location.x - geometry[frame].origin.x
        guard offset >= 0, offset <= geometry[frame].width,
            let date = proxy.value(atX: offset, as: Date.self)
        else { return nil }
        let steps = (date.timeIntervalSince(graph.start) / graph.step).rounded()
        return graph.start.addingTimeInterval(steps * graph.step)
    }

    /// The alert's firing time shaded in its severity's colour, its start marked.
    @ChartContentBuilder private var alertSpan: some ChartContent {
        let start = max(alert.startsAt, graph.start)
        let end = min(alert.endsAt ?? graph.end, graph.end)
        if start < end {
            RectangleMark(xStart: .value("Fired", start), xEnd: .value("Ended", end))
                .foregroundStyle(alert.severity.color.opacity(0.07))
        }
        if alert.startsAt >= graph.start {
            RuleMark(x: .value("Fired", alert.startsAt))
                .foregroundStyle(alert.severity.color.opacity(0.7))
                .lineStyle(StrokeStyle(lineWidth: 1))
                .annotation(position: labelSide(alert.startsAt), alignment: .top, spacing: 4) {
                    Text("Fired")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(alert.severity.color)
                }
        }
        if let endsAt = alert.endsAt, endsAt <= graph.end {
            RuleMark(x: .value("Resolved", endsAt))
                .foregroundStyle(alert.severity.color.opacity(0.5))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .annotation(position: labelSide(endsAt), alignment: .top, spacing: 4) {
                    Text("Resolved")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
        }
    }

    @ChartContentBuilder
    private func usageMarks(_ series: MetricGraph.Series, color: Color) -> some ChartContent {
        ForEach(Array(graph.segments(of: series).enumerated()), id: \.offset) { index, segment in
            let id = "\(series.name) \(index)"
            ForEach(segment, id: \.time) { point in
                AreaMark(
                    x: .value("Time", point.time), y: .value("CPU", point.value),
                    series: .value("Series", id), stacking: .unstacked
                )
                .foregroundStyle(
                    .linearGradient(
                        colors: [color.opacity(0.22), color.opacity(0.02)], startPoint: .top,
                        endPoint: .bottom)
                )
                .interpolationMethod(.monotone)
                LineMark(
                    x: .value("Time", point.time), y: .value("CPU", point.value),
                    series: .value("Series", id)
                )
                .foregroundStyle(color)
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.monotone)
            }
            // A lone sample draws no line: a dot instead.
            if segment.count == 1, let point = segment.first {
                PointMark(x: .value("Time", point.time), y: .value("CPU", point.value))
                    .foregroundStyle(color)
                    .symbolSize(12)
            }
        }
    }

    @ChartContentBuilder
    private func referenceMarks(_ series: MetricGraph.Series) -> some ChartContent {
        ForEach(Array(graph.segments(of: series).enumerated()), id: \.offset) { index, segment in
            ForEach(segment, id: \.time) { point in
                LineMark(
                    x: .value("Time", point.time), y: .value("CPU", point.value),
                    series: .value("Series", "\(series.role) \(index)")
                )
                .foregroundStyle(Color.gray)
                .lineStyle(StrokeStyle(lineWidth: 1, dash: series.role.dash ?? []))
                .interpolationMethod(.stepEnd)
            }
        }
    }

    @ChartContentBuilder private func hoverMarks(at date: Date) -> some ChartContent {
        let values = graph.values(at: date)
        RuleMark(x: .value("Time", date))
            .foregroundStyle(.secondary.opacity(0.6))
            .lineStyle(StrokeStyle(lineWidth: 1))
            .annotation(
                position: .trailing, alignment: .top, spacing: 8,
                overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
            ) {
                HoverReadout(date: date, values: values, names: graph.usage.map(\.name))
            }
        ForEach(values, id: \.name) { value in
            PointMark(x: .value("Time", date), y: .value("CPU", value.value))
                .foregroundStyle(color(of: value.name))
                .symbolSize(28)
        }
    }

    private func color(of name: String) -> Color {
        ContainerPalette.color(graph.usage.firstIndex { $0.name == name } ?? 0)
    }
}

/// The hover's box: the time, then each container's value in its colour.
private struct HoverReadout: View {
    let date: Date
    let values: [(name: String, value: Double)]
    /// Every container in order, for the colours.
    let names: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(date.formatted(date: .omitted, time: .shortened))
                .font(.caption.weight(.semibold))
            if values.isEmpty {
                Text("No data")
                    .foregroundStyle(.secondary)
            }
            ForEach(values, id: \.name) { value in
                HStack(spacing: 6) {
                    Circle()
                        .fill(ContainerPalette.color(names.firstIndex(of: value.name) ?? 0))
                        .frame(width: 6, height: 6)
                    Text(value.name)
                    Spacer(minLength: 10)
                    Text(CPUFormat.value(value.value))
                        .monospacedDigit()
                }
            }
        }
        .font(.caption)
        .padding(8)
        .fixedSize()
        .background(.regularMaterial, in: .rect(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 0.5) }
    }
}

/// The graph for VoiceOver's audio graph and data table: one series per container.
private struct PodCPUChartDescriptor: AXChartDescriptorRepresentable {
    let graph: MetricGraph
    let axisTop: Double

    func makeChartDescriptor() -> AXChartDescriptor {
        let time = AXNumericDataAxisDescriptor(
            title: "Time",
            range: graph.start.timeIntervalSince1970...graph.end.timeIntervalSince1970,
            gridlinePositions: []
        ) { Date(timeIntervalSince1970: $0).formatted(date: .omitted, time: .shortened) }
        let cpu = AXNumericDataAxisDescriptor(
            title: "CPU", range: 0...axisTop, gridlinePositions: []
        ) { CPUFormat.value($0) }
        return AXChartDescriptor(
            title: "CPU per container", summary: nil, xAxis: time, yAxis: cpu, additionalAxes: [],
            series: graph.usage.map { series in
                AXDataSeriesDescriptor(
                    name: series.name, isContinuous: true,
                    dataPoints: series.points.map {
                        AXDataPoint(x: $0.time.timeIntervalSince1970, y: $0.value)
                    })
            })
    }
}

extension IncomingAlert {
    /// When it resolved; nil while it fires.
    fileprivate var endsAt: Date? {
        if case .resolved(let endsAt) = state { endsAt } else { nil }
    }
}
