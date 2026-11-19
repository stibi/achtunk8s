import AchtungDomain
import Testing

private typealias Keys = (key: Shortcut.Key, modifiers: Set<Shortcut.Modifier>)

/// What macOS keeps for itself in every app: Spotlight, the app and window switchers,
/// hide and minimize, the Help menu's search, full screen, lock, log out, force quit,
/// the Dock, screenshots, the character viewer.
private let takenByMacOS: [Keys] = [
    (.space, [.command]),
    (.space, [.control, .command]),
    (.character("\t"), [.command]),
    (.character("`"), [.command]),
    (.character("h"), [.command]),
    (.character("h"), [.option, .command]),
    (.character("m"), [.command]),
    (.character("?"), [.command]),
    (.character("f"), [.control, .command]),
    (.character("q"), [.control, .command]),
    (.character("q"), [.shift, .command]),
    (.escape, [.option, .command]),
    (.character("d"), [.option, .command]),
    (.character("3"), [.shift, .command]),
    (.character("4"), [.shift, .command]),
    (.character("5"), [.shift, .command]),
]

@Test func noTwoShortcutsShareTheirKeys() {
    for shortcut in Shortcut.allCases {
        let same = Shortcut.allCases.filter {
            $0.key == shortcut.key && $0.modifiers == shortcut.modifiers
        }
        #expect(same == [shortcut], "\(shortcut.symbols) is taken twice")
    }
    #expect(Set(Shortcut.allCases.map(\.title)).count == Shortcut.allCases.count)
}

@Test func noShortcutTakesKeysMacOSKeepsForItself() {
    for shortcut in Shortcut.allCases {
        let isTaken = takenByMacOS.contains {
            $0.key == shortcut.key && $0.modifiers == shortcut.modifiers
        }
        #expect(!isTaken, "\(shortcut.symbols) belongs to macOS")
    }
}

@Test func everyShortcutIsListedOnceUnderItsGroupWithATitle() {
    let listed = Shortcut.Group.allCases.flatMap(\.shortcuts)
    #expect(listed.count == Shortcut.allCases.count)
    #expect(Set(listed) == Set(Shortcut.allCases))
    for group in Shortcut.Group.allCases {
        #expect(!group.shortcuts.isEmpty, "\(group.title) has no shortcuts")
    }
    for shortcut in Shortcut.allCases {
        #expect(!shortcut.title.isEmpty)
    }
}

@Test func keysAreWrittenAsMacOSWritesThem() {
    #expect(Shortcut.markAllRead.symbols == "⇧⌘K")
    #expect(Shortcut.markAllRead.keyLabels == ["⇧", "⌘", "K"])
    #expect(Shortcut.help.symbols == "⌥?")
    #expect(Shortcut.settings.symbols == "⌘,")
    #expect(Shortcut.back.symbols == "esc")
    #expect(Shortcut.open.symbols == "↩")
    #expect(Shortcut.selectNext.symbols == "↓")
    #expect(Shortcut.toggleCard.symbols == "space")
    #expect(Shortcut.commandPalette.symbols == "⌘P")
    #expect(Shortcut.paletteNext.symbols == "⌃N")
}

@Test func keysAreSpokenByName() {
    #expect(Shortcut.markAllRead.spokenKeys == "Shift Command K")
    #expect(Shortcut.help.spokenKeys == "Option Question Mark")
    #expect(Shortcut.settings.spokenKeys == "Command Comma")
    #expect(Shortcut.back.spokenKeys == "Escape")
    #expect(Shortcut.selectPrevious.spokenKeys == "Up Arrow")
    #expect(Shortcut.toggleCard.spokenKeys == "Space")
}

/// A letter is written lowercase, so ⇧ is always said by the modifiers, never by the case.
@Test func lettersAreLowercase() {
    for shortcut in Shortcut.allCases {
        if case .character(let character) = shortcut.key {
            #expect(String(character) == character.lowercased())
        }
    }
}

@Test func aShortcutFollowsItsCharacterAcrossKeyboardLayouts() {
    // "?" needs Shift on a US or Czech keyboard and might not on another.
    #expect(Shortcut.help.matches(characters: "?", held: [.option, .shift]))
    #expect(Shortcut.help.matches(characters: "?", held: [.option]))
    // The key that has "?" on it, pressed without Shift.
    #expect(!Shortcut.help.matches(characters: "/", held: [.option]))
    #expect(!Shortcut.help.matches(characters: ",", held: [.option]))
}

@Test func aShortcutNeedsExactlyItsModifiers() {
    #expect(Shortcut.markAllRead.matches(characters: "k", held: [.shift, .command]))
    #expect(!Shortcut.markAllRead.matches(characters: "k", held: [.command]))
    #expect(!Shortcut.help.matches(characters: "?", held: [.option, .command]))
    #expect(!Shortcut.help.matches(characters: "?", held: [.control, .option]))
    #expect(!Shortcut.help.matches(characters: "?", held: []))
    #expect(Shortcut.back.matches(characters: "\u{1B}", held: []))
    #expect(!Shortcut.back.matches(characters: "\u{1B}", held: [.command]))
    #expect(!Shortcut.back.matches(characters: "\u{1B}", held: [.shift]))
    #expect(Shortcut.open.matches(characters: "\r", held: []))
    #expect(Shortcut.toggleCard.matches(characters: " ", held: []))
    #expect(Shortcut.remindMe.matches(characters: "r", held: [.shift, .command]))
    #expect(!Shortcut.refresh.matches(characters: "r", held: [.shift, .command]))
    #expect(Shortcut.palettePrevious.matches(characters: "p", held: [.control]))
    #expect(!Shortcut.palettePrevious.matches(characters: "p", held: [.command]))
    #expect(!Shortcut.commandPalette.matches(characters: "p", held: [.control]))
}

@Test func capsLockDoesNotChangeALetterShortcut() {
    #expect(Shortcut.quit.matches(characters: "Q", held: [.command]))
    #expect(Shortcut.closeWindow.matches(characters: "W", held: [.command]))
}
