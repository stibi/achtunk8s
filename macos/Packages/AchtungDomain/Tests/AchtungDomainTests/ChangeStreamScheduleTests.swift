import AchtungDomain
import Testing

@Test func aDropWaitsTheServersRetryAndRepeatedFailuresBackOffToAMinute() {
    var schedule = ChangeStreamSchedule()
    #expect(schedule.delay == .seconds(5))

    schedule.serverAsked(retry: .seconds(3))
    schedule.ended(afterReady: false)
    #expect(schedule.delay == .seconds(3))
    let delays = (1...6).map { _ in
        schedule.ended(afterReady: false)
        return schedule.delay
    }
    #expect(
        delays == [
            .seconds(6), .seconds(12), .seconds(24), .seconds(48), .seconds(60), .seconds(60),
        ])
}

@Test func aStreamThatSaidReadyEndsCleanly() {
    // A gateway cutting every request at 15 s: the stream worked, so it isn't a failure.
    var schedule = ChangeStreamSchedule()
    schedule.ended(afterReady: false)
    schedule.ended(afterReady: false)

    schedule.ended(afterReady: true)

    #expect(schedule.failures == 0)
    #expect(schedule.delay == .seconds(5))
}

@Test func pollingSlowsDownWhileTheStreamIsLive() {
    #expect(ChangeStreamSchedule.pollAge(isLive: true) == 115)
    #expect(ChangeStreamSchedule.pollAge(isLive: false) == 20)
}
