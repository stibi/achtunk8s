import AchtungDomain
import Foundation
import Testing

private let start = Date(timeIntervalSince1970: 1_800_000_000)

private func minutes(_ minutes: Double) -> Date {
    start.addingTimeInterval(minutes * 60)
}

private func series(
    _ name: String, _ role: MetricGraph.Role = .usage, _ values: [Double?]
) -> MetricGraph.Series {
    MetricGraph.Series(
        name: name, role: role,
        points: values.enumerated().compactMap { index, value in
            value.map { MetricGraph.Point(time: minutes(Double(index)), value: $0) }
        })
}

private func graph(_ series: [MetricGraph.Series], minutes length: Double = 180) -> MetricGraph {
    MetricGraph(
        panel: .podCPU, unit: .cores, start: start, end: minutes(length), step: 60,
        series: series, truncated: false)
}

@Test func aGapLongerThanAStepAndAHalfBreaksTheLine() {
    let api = series("api", .usage, [0.1, 0.2, nil, nil, 0.3, 0.4])
    let segments = graph([api]).segments(of: api)

    #expect(segments.map { $0.map(\.value) } == [[0.1, 0.2], [0.3, 0.4]])
}

@Test func samplesThatStopWellBeforeTheEndMeanThePodEnded() {
    let ended = graph([series("api", .usage, [0.1, 0.2, 0.3])], minutes: 10)
    let going = graph([series("api", .usage, [0.1, 0.2, 0.3])], minutes: 3)

    #expect(ended.endedAt == minutes(2))
    #expect(going.endedAt == nil)
}

@Test func referencesAreTheAlertsOwnContainersOrTheOnlyOnes() {
    let several = graph([
        series("api", .usage, [0.1]), series("api", .request, [0.25]),
        series("api", .limit, [0.5]), series("proxy", .usage, [0.01]),
        series("proxy", .limit, [0.1]),
    ])
    let one = graph([series("api", .usage, [0.1]), series("api", .request, [0.25])])

    #expect(several.references(alertContainer: "proxy").map(\.role) == [.limit])
    #expect(several.references(alertContainer: nil).isEmpty)
    #expect(several.references(alertContainer: "gone").isEmpty)
    #expect(one.references(alertContainer: nil).map(\.role) == [.request])
}

@Test func theValueAxisLeavesOutALimitFarAboveTheUsage() {
    let near = graph([series("api", .usage, [0.4]), series("api", .limit, [0.5])])
    let far = graph([series("api", .usage, [0.05]), series("api", .limit, [4])])

    #expect(abs(near.valueAxisTop(references: near.references(alertContainer: nil)) - 0.575) < 1e-9)
    #expect(abs(far.valueAxisTop(references: far.references(alertContainer: nil)) - 0.0575) < 1e-9)
    #expect(graph([]).valueAxisTop(references: []) == 0.1)
}

@Test func hoverShowsEachContainersValueNearTheTime() {
    let pod = graph([series("api", .usage, [0.1, 0.2]), series("proxy", .usage, [0.01])])

    let values = pod.values(at: minutes(1.2))

    #expect(values.map(\.name) == ["api"])
    #expect(values.map(\.value) == [0.2])
}

@Test func anEmptyGraphHasNoUsage() {
    #expect(graph([]).isEmpty)
    #expect(graph([series("api", .request, [0.1])]).isEmpty)
    #expect(!graph([series("api", .usage, [0])]).isEmpty)
}

@Test func timeTicksAreHalfHoursForThreeHoursAndWiderForADay() {
    #expect(graph([], minutes: 180).timeTickMinutes == 30)
    #expect(graph([], minutes: 240).timeTickMinutes == 30)
    #expect(graph([], minutes: 360).timeTickMinutes == 60)
    #expect(graph([], minutes: 1440).timeTickMinutes == 180)
}

@Test func cpuReadsInMillicoresBelowACoreAndInCoresAbove() {
    #expect(CPUFormat.value(0.25) == "250m")
    #expect(CPUFormat.value(1) == "1 core")
    #expect(CPUFormat.value(0.9996) == "1 core")
    #expect(CPUFormat.value(1.5) == "1.5 cores")
    #expect(CPUFormat.axisLabel(0.5, axisTop: 0.8) == "500m")
    #expect(CPUFormat.axisLabel(0.5, axisTop: 2) == "0.5")
}

@Test func timeTicksFallOnRoundTimes() throws {
    // 1_800_000_000 is 08:00 UTC; a window from 08:09 to 11:09.
    let shifted = MetricGraph(
        panel: .podCPU, unit: .cores, start: minutes(9), end: minutes(189), step: 60,
        series: [], truncated: false)

    let utc = shifted.timeTicks(in: try #require(TimeZone(identifier: "UTC")))
    #expect(utc.first == minutes(30))
    #expect(utc.last == minutes(180))
    #expect(utc.count == 6)
    // Half an hour ahead of UTC, round local half-hours are UTC's too; whole hours aren't.
    let longer = MetricGraph(
        panel: .podCPU, unit: .cores, start: minutes(9), end: minutes(369), step: 60,
        series: [], truncated: false)
    #expect(longer.timeTicks(in: try #require(TimeZone(secondsFromGMT: 1800))).first == minutes(30))
    #expect(longer.timeTicks(in: try #require(TimeZone(identifier: "UTC"))).first == minutes(60))
}
