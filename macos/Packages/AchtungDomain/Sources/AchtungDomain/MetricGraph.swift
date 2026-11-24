import Foundation

/// A graph the server can draw for an occurrence (ADR 0026). The server lists the ones an
/// occurrence has in its detail; ones this client doesn't know are left out.
public enum MetricPanel: String, Sendable, Hashable, CaseIterable {
    /// The CPU usage of each container of the alert's pod, with requests and limits.
    case podCPU = "pod-cpu"
}

/// What the server answered for a panel: series over a window, oldest point first.
public struct MetricGraph: Sendable, Hashable {
    public enum Unit: Sendable, Hashable {
        case cores
    }

    /// What a series is: what was used, or the request or limit to read it against.
    public enum Role: Sendable, Hashable {
        case usage, request, limit
    }

    public struct Point: Sendable, Hashable {
        public let time: Date
        public let value: Double

        public init(time: Date, value: Double) {
            self.time = time
            self.value = value
        }
    }

    public struct Series: Sendable, Hashable {
        /// E.g. the container's name.
        public let name: String
        public let role: Role
        /// Oldest first, only where the backend has a value.
        public let points: [Point]

        public init(name: String, role: Role, points: [Point]) {
            self.name = name
            self.role = role
            self.points = points
        }
    }

    public let panel: MetricPanel
    public let unit: Unit
    public let start: Date
    public let end: Date
    /// The time between two points.
    public let step: TimeInterval
    /// By name, then usage, request, limit.
    public let series: [Series]
    /// True when the server left series out (it sends the 10 busiest).
    public let truncated: Bool

    public init(
        panel: MetricPanel, unit: Unit, start: Date, end: Date, step: TimeInterval,
        series: [Series], truncated: Bool
    ) {
        self.panel = panel
        self.unit = unit
        self.start = start
        self.end = end
        self.step = step
        self.series = series
        self.truncated = truncated
    }

    /// The usage series, in the server's order, which gives each its colour.
    public var usage: [Series] {
        series.filter { $0.role == .usage }
    }

    /// True when there is nothing to draw: the backend has no samples for the window.
    public var isEmpty: Bool {
        usage.allSatisfy(\.points.isEmpty)
    }

    /// The request and limit drawn as reference lines: those of the alert's own container
    /// (its `container` label) or of the only container. With several and none named, none:
    /// one line per container's request and limit would be clutter.
    public func references(alertContainer: String?) -> [Series] {
        let names = usage.map(\.name)
        let focus =
            alertContainer.flatMap { names.contains($0) ? $0 : nil }
            ?? (names.count == 1 ? names.first : nil)
        guard let focus else { return [] }
        return series.filter { $0.name == focus && $0.role != .usage && !$0.points.isEmpty }
    }

    /// A series cut where the backend has no point for longer than a step and a half, so the
    /// line breaks there instead of bridging the gap (a restart, a scrape that failed).
    public func segments(of series: Series) -> [[Point]] {
        var segments: [[Point]] = []
        for point in series.points {
            if let last = segments.last?.last, point.time.timeIntervalSince(last.time) <= step * 1.5
            {
                segments[segments.count - 1].append(point)
            } else {
                segments.append([point])
            }
        }
        return segments
    }

    /// When the samples stopped, if well before the window's end: the pod is gone, which
    /// for an OOM kill or an eviction is the point of the graph. Nil while they go on.
    public var endedAt: Date? {
        guard let last = usage.compactMap(\.points.last?.time).max() else { return nil }
        return end.timeIntervalSince(last) > step * 3 ? last : nil
    }

    /// The top of the value axis: the highest usage and request, with some room above. The
    /// limit counts too unless it is far above both: a 4-core limit would flatten a pod that
    /// uses 50 millicores into the floor; its value is in the legend instead.
    public func valueAxisTop(references: [Series]) -> Double {
        let peak = usage.flatMap(\.points).map(\.value).max() ?? 0
        let request =
            references.filter { $0.role == .request }.flatMap(\.points).map(\.value)
            .max() ?? 0
        let limit =
            references.filter { $0.role == .limit }.flatMap(\.points).map(\.value)
            .max() ?? 0
        let shown = max(peak, request)
        let top = limit <= max(shown, 0.001) * 2 ? max(shown, limit) : shown
        return top > 0 ? top * 1.15 : 0.1
    }

    /// Each usage series' value at the point nearest `date`, within half a step: what the
    /// hover shows. Series without a point there are left out.
    public func values(at date: Date) -> [(name: String, value: Double)] {
        usage.compactMap { series in
            guard
                let nearest = series.points.min(by: {
                    abs($0.time.timeIntervalSince(date)) < abs($1.time.timeIntervalSince(date))
                }), abs(nearest.time.timeIntervalSince(date)) <= step / 2
            else { return nil }
            return (series.name, nearest.value)
        }
    }

    /// The time axis' tick spacing for the window, in minutes: half-hours for 3 hours, wider
    /// for longer windows, so there are 4 to 8 labels.
    public var timeTickMinutes: Int {
        let hours = end.timeIntervalSince(start) / 3600
        return [30, 60, 120, 180, 240, 360].first { hours * 60 / Double($0) <= 8 } ?? 360
    }
}

extension MetricGraph {
    /// The time axis' ticks: every `timeTickMinutes`, on round times in `timeZone` (13:00,
    /// 13:30, or 12:00, 15:00 for 3 hours) rather than counted from the window's start.
    public func timeTicks(in timeZone: TimeZone = .current) -> [Date] {
        let spacing = TimeInterval(timeTickMinutes * 60)
        let offset = TimeInterval(timeZone.secondsFromGMT(for: start))
        let local = start.timeIntervalSince1970 + offset
        let first = (local / spacing).rounded(.up) * spacing - offset
        return stride(from: first, through: end.timeIntervalSince1970, by: spacing)
            .map(Date.init(timeIntervalSince1970:))
    }
}

/// How CPU values read: millicores below one core ("250m", Kubernetes' own notation),
/// cores above ("1.5").
public enum CPUFormat {
    /// A value on an axis whose top is `axisTop`, so every label uses one unit.
    public static func axisLabel(_ cores: Double, axisTop: Double) -> String {
        axisTop < 1 ? millicores(cores) : coresText(cores)
    }

    /// One value alone, e.g. in the hover or the legend, with its unit.
    public static func value(_ cores: Double) -> String {
        // Rounded first, so 0.9996 reads "1 core", not "1000m".
        let millicores = (cores * 1000).rounded()
        switch millicores {
        case ..<1000: return "\(Int(millicores))m"
        case 1000: return "1 core"
        default: return "\(coresText(cores)) cores"
        }
    }

    private static func millicores(_ cores: Double) -> String {
        "\(Int((cores * 1000).rounded()))m"
    }

    private static func coresText(_ cores: Double) -> String {
        cores.formatted(.number.precision(.fractionLength(0...2)).locale(Locale(identifier: "en")))
    }
}
