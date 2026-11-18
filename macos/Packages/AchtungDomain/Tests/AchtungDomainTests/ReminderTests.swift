import AchtungDomain
import Foundation
import Testing

private func calendar(_ zone: String = "Europe/Prague") -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: zone) ?? .gmt
    return calendar
}

/// "2026-11-18 14:42:31" on the wall clock of `zone`.
private func time(_ text: String, _ zone: String = "Europe/Prague") -> Date {
    let parts = text.split(whereSeparator: { " -:".contains($0) }).map { Int($0) ?? 0 }
    return calendar(zone).date(
        from: DateComponents(
            year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4],
            second: parts.count > 5 ? parts[5] : 0)) ?? .distantPast
}

private func date(_ preset: ReminderPreset, at now: String, _ zone: String = "Europe/Prague")
    -> Date?
{
    preset.date(at: time(now, zone), calendar: calendar(zone))
}

@Test func anAfternoonOffersAllFour() {
    // A Wednesday.
    let now = "2026-11-18 14:42:31"
    #expect(date(.laterToday, at: now) == time("2026-11-18 17:42"))
    #expect(date(.thisEvening, at: now) == time("2026-11-18 18:00"))
    #expect(date(.tomorrowMorning, at: now) == time("2026-11-19 08:00"))
    #expect(date(.nextWeek, at: now) == time("2026-11-23 08:00"))
    #expect(
        ReminderPreset.options(at: time(now), calendar: calendar()).map(\.preset)
            == [.laterToday, .thisEvening, .tomorrowMorning, .nextWeek])
}

@Test func thisEveningIsGoneOnceItIsEvening() {
    #expect(date(.thisEvening, at: "2026-11-18 17:59:59") == time("2026-11-18 18:00"))
    #expect(date(.thisEvening, at: "2026-11-18 18:00") == nil)
    #expect(date(.thisEvening, at: "2026-11-18 19:10") == nil)
    #expect(
        ReminderPreset.options(at: time("2026-11-18 19:10"), calendar: calendar()).map(\.preset)
            == [.laterToday, .tomorrowMorning, .nextWeek])
}

@Test func laterTodayIsGoneWhenThatIsTomorrow() {
    #expect(date(.laterToday, at: "2026-11-18 20:59") == time("2026-11-18 23:59"))
    #expect(date(.laterToday, at: "2026-11-18 21:00") == nil)
    #expect(date(.laterToday, at: "2026-11-18 23:30") == nil)
    // Tomorrow morning is still tomorrow's, a minute before midnight and a minute after.
    #expect(date(.tomorrowMorning, at: "2026-11-18 23:59") == time("2026-11-19 08:00"))
    #expect(date(.tomorrowMorning, at: "2026-11-19 00:01") == time("2026-11-20 08:00"))
}

@Test func nextWeekIsTheNextMondayThatIsntToday() {
    #expect(date(.nextWeek, at: "2026-11-23 07:00") == time("2026-11-30 08:00"))
    #expect(date(.nextWeek, at: "2026-11-21 12:00") == time("2026-11-23 08:00"))
    // Across the year's end.
    #expect(date(.nextWeek, at: "2026-12-30 12:00") == time("2027-01-04 08:00"))
}

@Test func onASundayNextWeekIsTomorrowMorningAndOfferedOnce() {
    let now = time("2026-11-22 10:00")
    #expect(date(.nextWeek, at: "2026-11-22 10:00") == time("2026-11-23 08:00"))
    let options = ReminderPreset.options(at: now, calendar: calendar())
    #expect(options.map(\.preset) == [.laterToday, .thisEvening, .tomorrowMorning])
    #expect(options.last?.date == time("2026-11-23 08:00"))
}

@Test func aMorningIsEightOnTheWallClockAcrossAClockChange() {
    // Europe/Prague: clocks go forward on 2027-03-28 and back on 2026-10-25.
    let spring = date(.tomorrowMorning, at: "2027-03-27 20:00")
    #expect(spring == time("2027-03-28 08:00"))
    #expect(spring == time("2027-03-27 20:00").addingTimeInterval(11 * 3600))
    let autumn = date(.tomorrowMorning, at: "2026-10-24 20:00")
    #expect(autumn == time("2026-10-25 08:00"))
    #expect(autumn == time("2026-10-24 20:00").addingTimeInterval(13 * 3600))
    // And a week that holds the change still ends on Monday at eight.
    #expect(date(.nextWeek, at: "2027-03-25 09:00") == time("2027-03-29 08:00"))
}

@Test func laterTodayIsThreeHoursOfTimeNotOfTheClock() {
    // 01:30 on the night the clocks go forward: three hours later it reads 05:30.
    #expect(date(.laterToday, at: "2027-03-28 01:30") == time("2027-03-28 05:30"))
}

@Test func thePresetsAreInTheUsersTimeZone() {
    // One instant: Wednesday 23:30 in Prague, 17:30 in New York.
    let now = time("2026-11-18 23:30")
    #expect(now == time("2026-11-18 17:30", "America/New_York"))
    let newYork = calendar("America/New_York")
    #expect(
        ReminderPreset.thisEvening.date(at: now, calendar: newYork)
            == time("2026-11-18 18:00", "America/New_York"))
    #expect(ReminderPreset.thisEvening.date(at: now, calendar: calendar()) == nil)
    #expect(
        ReminderPreset.tomorrowMorning.date(at: now, calendar: newYork)
            == time("2026-11-19 08:00", "America/New_York"))
    #expect(
        ReminderPreset.tomorrowMorning.date(at: now, calendar: calendar())
            == time("2026-11-19 08:00"))
}

@Test func everyPresetIsInTheFutureAndWithinWhatTheServerTakes() {
    for hour in 0..<24 {
        let now = time("2026-11-22 \(hour):17:05")
        let range = ReminderTime.range(at: now)
        for option in ReminderPreset.options(at: now, calendar: calendar()) {
            #expect(option.date > now)
            #expect(range.contains(option.date))
        }
    }
}

@Test func pickingATimeStartsFromTomorrowMorning() {
    #expect(
        ReminderPreset.suggestion(at: time("2026-11-18 14:42"), calendar: calendar())
            == time("2026-11-19 08:00"))
}

@Test func aPendingReminderAndOneThatCameDueAreOnTheOccurrence() {
    let plain = Fixture.occurrence(id: 1, lastEventAt: Fixture.start)
    #expect(plain.remindAt == nil)
    #expect(!plain.isReminded)
    #expect(
        Fixture.occurrence(id: 1, lastEventAt: Fixture.start, lastEventKind: .reminded).isReminded)
}
