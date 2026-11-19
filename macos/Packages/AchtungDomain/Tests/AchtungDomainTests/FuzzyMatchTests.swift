import AchtungDomain
import Testing

@Test(arguments: [
    // The characters in order, next to each other or not.
    ("pay", "payments", [0, 1, 2]),
    ("pmt", "payments", [0, 3, 6]),
    // Case and diacritics don't matter, in the query or in the text.
    ("PAY", "payments", [0, 1, 2]),
    ("pay", "Payments", [0, 1, 2]),
    ("zlu", "Žluťoučký kůň", [0, 1, 2]),
    ("žlú kun", "zlutoucky kun", [0, 1, 2, 10, 11, 12]),
    // The start of a word is a better fit than the middle of one.
    ("gl", "Go to Live", [0, 6]),
    ("l", "all-live", [4]),
    ("kpc", "KubePodCrashLooping", [0, 4, 7]),
    ("v2", "api-v2", [4, 5]),
    // Characters together are a better fit than the same ones apart.
    ("ar", "bazaar", [4, 5]),
    // Each word of the query is found on its own, in any order.
    ("prod plat", "platform eu-prod", [0, 1, 2, 3, 12, 13, 14, 15]),
    ("  platform  ", "platform", [0, 1, 2, 3, 4, 5, 6, 7]),
])
func aQueryMatchesTheCharactersToHighlight(query: String, text: String, matched: [Int]) {
    #expect(FuzzyMatch(query: query, in: text)?.matched == matched)
}

@Test(arguments: [
    ("xyz", "payments"),
    // Out of order.
    ("yap", "payments"),
    // Longer than the text.
    ("paymentss", "payments"),
    // Every word has to be there.
    ("pay staging", "payments eu-prod"),
])
func aQueryThatIsNotInTheTextDoesNotMatch(query: String, text: String) {
    #expect(FuzzyMatch(query: query, in: text) == nil)
}

@Test func aQueryWithoutWordsMatchesAnythingAndHighlightsNothing() {
    #expect(FuzzyMatch(query: "", in: "payments")?.matched == [])
    #expect(FuzzyMatch(query: "  ", in: "")?.matched == [])
}

@Test(arguments: [
    // A prefix first, the shorter text first among equals; then the start of a later word;
    // then the middle of one.
    (
        "pay", ["prepayments", "team-pay", "payments", "pay"],
        ["pay", "payments", "team-pay", "prepayments"]
    ),
    // Matches closer together first.
    ("ab", ["a-xyz-b", "a-b"], ["a-b", "a-xyz-b"]),
    ("db", ["dashboard", "db-backup"], ["db-backup", "dashboard"]),
    // Initials of words before letters inside a word.
    ("sa", ["Usable", "Silence Selected Alert"], ["Silence Selected Alert", "Usable"]),
    // What doesn't match is left out.
    ("search", ["payments", "search", "platform"], ["search"]),
    // Equal matches of equal length stay as given.
    ("p", ["payments", "platform"], ["payments", "platform"]),
    ("P", ["platform", "payments"], ["platform", "payments"]),
    // Without a query, everything, as given.
    ("", ["platform", "db", "payments"], ["platform", "db", "payments"]),
    (" ", ["platform", "db"], ["platform", "db"]),
])
func itemsAreRankedBestMatchFirst(query: String, items: [String], ranked: [String]) {
    #expect(FuzzyMatch.ranked(items, by: query) { $0 }.map(\.item) == ranked)
}

@Test func rankingMatchesTheTextEachItemGives() {
    let channels = [
        (slug: "platform", instance: "eu-prod"), (slug: "platform", instance: "staging"),
    ]

    let ranked = FuzzyMatch.ranked(channels, by: "plat stag") { "\($0.slug) \($0.instance)" }

    #expect(ranked.map(\.item.instance) == ["staging"])
    #expect(ranked.first?.match.matched == [0, 1, 2, 3, 9, 10, 11, 12])
}
