import Foundation

/// How a typed query fits a text, for the command palette (⌘P). Every word of the query
/// must be in the text as a subsequence: its characters in order, not necessarily next to
/// each other, ignoring case and diacritics. The words may be anywhere, in any order, so
/// "prod plat" finds "platform eu-prod".
///
/// Of all the ways a word fits, the best one counts: a character at the start of the text
/// scores most, then one at the start of a word ("p" in "eu-prod", "C" in "PodCrash"),
/// then one right after the previous match; characters skipped between two matches cost
/// a little.
public struct FuzzyMatch: Hashable, Sendable {
    private static let textStart = 10
    private static let wordStart = 8
    private static let consecutive = 5
    /// Skipped characters cost one each, up to this many: initials of far-apart words
    /// ("sa" in "Silence Selected Alert") still beat two letters inside a word.
    private static let largestGapCost = 3

    /// Higher fits better. Only comparable between matches of the same query.
    public let score: Int
    /// The matched characters, as ascending offsets into the text's characters, to
    /// highlight.
    public let matched: [Int]

    /// Nil when a word of the query isn't in the text. A query without words matches
    /// anything, with nothing to highlight.
    public init?(query: String, in text: String) {
        let characters = Array(text)
        let folded = characters.map(Self.fold)
        let bonuses = Self.bonuses(for: characters)
        var score = 0
        var matched: Set<Int> = []
        for word in query.split(whereSeparator: \.isWhitespace) {
            guard let fit = Self.fit(of: word.map(Self.fold), in: folded, bonuses: bonuses)
            else { return nil }
            score += fit.score
            matched.formUnion(fit.offsets)
        }
        self.score = score
        self.matched = matched.sorted()
    }

    /// The items the query matches, best first; equal ones with the shorter text first,
    /// then as given. A query without words keeps every item, as given.
    public static func ranked<Item>(
        _ items: [Item], by query: String, text: (Item) -> String
    ) -> [(item: Item, match: FuzzyMatch)] {
        let found = items.enumerated().compactMap { index, item in
            let text = text(item)
            return FuzzyMatch(query: query, in: text).map {
                (index: index, item: item, match: $0, length: text.count)
            }
        }
        guard query.contains(where: { !$0.isWhitespace }) else {
            return found.map { ($0.item, $0.match) }
        }
        return found.sorted {
            ($1.match.score, $0.length, $0.index) < ($0.match.score, $1.length, $1.index)
        }
        .map { ($0.item, $0.match) }
    }

    /// A character without its case and diacritics: "Ž" and "z" are the same.
    private static func fold(_ character: Character) -> String {
        String(character).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    /// What a match at each character adds: most at the start of the text, then at the
    /// start of a word, which is a letter or digit after something else, or a capital
    /// after a small letter.
    private static func bonuses(for characters: [Character]) -> [Int] {
        characters.indices.map { index in
            guard index > 0 else { return textStart }
            let character = characters[index]
            let before = characters[index - 1]
            let startsWord =
                (character.isLetter || character.isNumber) && !(before.isLetter || before.isNumber)
            let startsCapital = character.isUppercase && before.isLowercase
            return startsWord || startsCapital ? wordStart : 0
        }
    }

    /// The best way `word` is a subsequence of `text`, or nil when it isn't one.
    private static func fit(
        of word: [String], in text: [String], bonuses: [Int]
    ) -> (score: Int, offsets: [Int])? {
        guard let first = word.first, word.count <= text.count else { return nil }
        // `scores[i][j]`: the best score of the word's first i + 1 characters, the last of
        // them at j; `previous[i][j]`: where the character before it then is.
        var scores: [[Int?]] = [text.indices.map { text[$0] == first ? bonuses[$0] : nil }]
        var previous: [[Int]] = [Array(repeating: 0, count: text.count)]
        for (index, character) in word.enumerated().dropFirst() {
            var row = [Int?](repeating: nil, count: text.count)
            var from = [Int](repeating: 0, count: text.count)
            for end in text.indices where text[end] == character {
                for before in 0..<end {
                    guard let score = scores[index - 1][before] else { continue }
                    let gap = end - before - 1
                    let step =
                        gap == 0
                        ? max(consecutive, bonuses[end]) : bonuses[end] - min(gap, largestGapCost)
                    if row[end].map({ score + step > $0 }) ?? true {
                        row[end] = score + step
                        from[end] = before
                    }
                }
            }
            scores.append(row)
            previous.append(from)
        }
        return best(scores: scores, previous: previous)
    }

    /// The highest score of the whole word, the earliest of equal ones, and the offsets
    /// that gave it.
    private static func best(
        scores: [[Int?]], previous: [[Int]]
    ) -> (score: Int, offsets: [Int])? {
        var end: (offset: Int, score: Int)?
        for (offset, score) in scores[scores.count - 1].enumerated() {
            if let score, end.map({ score > $0.score }) ?? true {
                end = (offset, score)
            }
        }
        guard let end else { return nil }
        var offsets = [end.offset]
        for index in stride(from: scores.count - 1, to: 0, by: -1) {
            offsets.append(previous[index][offsets[offsets.count - 1]])
        }
        return (end.score, offsets.reversed())
    }
}
