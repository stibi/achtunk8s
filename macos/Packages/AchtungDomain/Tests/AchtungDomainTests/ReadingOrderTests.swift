import AchtungDomain
import Foundation
import Testing

@Test func aListReadsNewOnesFirstInTheirOwnOrder() {
    var state = ReadState()
    state.markSeen(upTo: Fixture.minutes(2))
    let older = Fixture.occurrence(id: 1, lastEventAt: Fixture.minutes(1))
    let newer = Fixture.occurrence(id: 2, lastEventAt: Fixture.minutes(4))
    let newest = Fixture.occurrence(id: 3, lastEventAt: Fixture.minutes(3))
    let oldest = Fixture.occurrence(id: 4, lastEventAt: Fixture.minutes(0))

    let order = state.newFirst([older, newer, oldest, newest])

    #expect(order.new.map(\.id) == [2, 3])
    #expect(order.earlier.map(\.id) == [1, 4])
}

@Test func expandingTheNextLiveCardDropsThePreviousOneOnceRead() {
    var state = ReadState()
    let first = Fixture.occurrence(id: 1, lastEventAt: Fixture.minutes(2))
    let second = Fixture.occurrence(id: 2, lastEventAt: Fixture.minutes(1))
    let stream = [first, second]

    state.markRead(first)
    #expect(
        state.shown(own: stream, feed: stream, in: .allChannels, keeping: 1).map(\.id) == [1, 2])

    state.markRead(second)
    #expect(state.shown(own: stream, feed: stream, in: .allChannels, keeping: 2).map(\.id) == [2])
    #expect(state.shown(own: stream, feed: stream, in: .allChannels, keeping: nil).isEmpty)

    state.setHidesRead(false, in: .allChannels)
    #expect(
        state.shown(own: stream, feed: stream, in: .allChannels, keeping: 2).map(\.id) == [1, 2])
}
