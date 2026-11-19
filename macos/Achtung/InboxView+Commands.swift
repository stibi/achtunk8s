import AchtungDomain
import SwiftUI

// What the command palette (⌘P, `CommandPalette`) offers in this window right now: the
// channels, the pages, and what the window's buttons and menus do, each with the shortcut
// it has there. A command that needs something it doesn't have says so, or is left out.
extension InboxView {
    /// The channels visited last, the pages, the window's commands, then every other
    /// channel as the sidebar has them. The palette adds the app's own commands.
    var paletteCommands: [PaletteCommand] {
        let channels = model.sidebar.flatMap(\.channels)
        let recent =
            recentChannels
            .filter { .channel($0) != selectedScope }
            .compactMap { id in channels.first { $0.id == id } }
            .prefix(5)
        // The alert whose detail is on screen, which Copy for Agent and Silence are about.
        let occurrence = activeSearch == nil ? selectedOccurrence : nil
        return recent.map { channelCommand($0, group: .recent) }
            + pageCommands
            + [refreshCommand, markAllReadCommand].compactMap(\.self)
            + [copyCommand(for: occurrence), silenceCommand(for: occurrence)]
            + [remindCommand(for: occurrence)]
            + windowCommands
            + channels.filter { !recent.contains($0) }.map { channelCommand($0, group: .channel) }
    }

    /// A channel opened counts as visited, the newest first.
    func rememberVisit() {
        guard case .channel(let id) = selectedScope else { return }
        recentChannels.removeAll { $0 == id }
        recentChannels.insert(id, at: 0)
    }

    /// Like choosing a sidebar row, which ends a search.
    private func go(to page: InboxPage) -> PaletteCommand.Action {
        .run { sidebarSelection.wrappedValue = page }
    }

    /// With its instance, as two instances can have a channel of the same name (ADR 0006).
    private func channelCommand(
        _ summary: ChannelSummary, group: PaletteCommand.Group
    ) -> PaletteCommand {
        PaletteCommand(
            id: "channel \(summary.id.instance) \(summary.id.slug)", title: summary.id.slug,
            detail: summary.id.instance, group: group, systemImage: "number",
            unread: summary.unread, unreadCritical: summary.unreadCritical,
            action: go(to: .list(.channel(summary.id))))
    }

    /// Home, Live, and the detail of each Alertmanager Home has a tile for.
    private var pageCommands: [PaletteCommand] {
        let alertmanagers = model.homeModel.home?.alertmanagers ?? []
        return [
            PaletteCommand(
                id: "home", title: "Home", group: .page, systemImage: "house",
                action: go(to: .home)),
            PaletteCommand(
                id: "live", title: "Live", group: .page,
                systemImage: "dot.radiowaves.left.and.right",
                action: go(to: .list(.allChannels))),
        ]
            + alertmanagers.map {
                PaletteCommand(
                    id: "alertmanager \($0.instance)", title: "Alertmanager",
                    detail: $0.instance, group: .page, systemImage: "server.rack",
                    action: go(to: .alertmanager(instance: $0.instance)))
            }
    }

    /// Reloads what is on screen. ⌘R is the refresh button's on Home and an Alertmanager's
    /// detail; a list has neither.
    private var refreshCommand: PaletteCommand {
        let shown = activeSearch == nil ? page : nil
        let hasButton = if case .list = shown { false } else { shown != nil }
        return PaletteCommand(
            id: "refresh", title: "Refresh", group: .action, systemImage: "arrow.clockwise",
            shortcut: hasButton ? .refresh : nil,
            action: .run {
                Task {
                    switch shown {
                    case .home: await model.homeModel.refreshHome()
                    case .alertmanager(let instance):
                        await model.homeModel.refreshAlerts(of: instance)
                    case .list, nil: await model.refresh(shownScope, visiting: true)
                    }
                }
            })
    }

    /// Only where the header has the button: Live and a channel.
    private var markAllReadCommand: PaletteCommand? {
        guard activeSearch == nil, let scope = selectedScope else { return nil }
        let list: String? =
            switch scope {
            case .allChannels: "Live"
            case .channel(let id): "\(id.slug) · \(id.instance)"
            case .search: nil
            }
        return PaletteCommand(
            id: "mark-all-read", title: "Mark All as Read", detail: list, group: .action,
            systemImage: "checkmark.circle", shortcut: .markAllRead,
            unavailable: model.hasUnread(in: scope) ? nil : "Nothing unread",
            action: .run { markAllRead(in: scope) })
    }

    private func copyCommand(for occurrence: Occurrence?) -> PaletteCommand {
        PaletteCommand(
            id: "copy-for-agent", title: "Copy for Agent", detail: occurrence?.alert.title,
            group: .action, systemImage: "doc.on.doc", shortcut: .copyForAgent,
            unavailable: occurrence == nil ? "No alert open" : nil,
            action: .run {
                if let occurrence {
                    copy(occurrence)
                }
            })
    }

    /// Asks for how long, with the choices of the alert's silence button (`SilenceButton`):
    /// a silenced alert's own silence is changed, or ended.
    private func silenceCommand(for occurrence: Occurrence?) -> PaletteCommand {
        let isSilenced = occurrence?.isSilenced(at: .now) ?? false
        var choices: [PaletteCommand] = []
        if let occurrence {
            choices = SilenceDuration.allCases.map { duration in
                PaletteCommand(
                    id: "silence \(duration.rawValue)",
                    title: "Silence for \(duration.title)\(isSilenced ? " from Now" : "")",
                    group: .action, systemImage: "bell.slash",
                    action: .attempt {
                        await model.silence(occurrence, for: duration).map {
                            "Couldn't silence the alert: \($0.detail)"
                        }
                    })
            }
            if isSilenced {
                choices.append(endSilenceCommand(for: occurrence))
            }
        }
        return PaletteCommand(
            id: "silence", title: isSilenced ? "Change Silence…" : "Silence Alert…",
            detail: occurrence?.alert.title, group: .action, systemImage: "bell.slash",
            unavailable: occurrence == nil ? "No alert open" : nil,
            action: .choose(
                prompt: "Silence for every receiver of its Alertmanager, for…", from: choices))
    }

    private func endSilenceCommand(for occurrence: Occurrence) -> PaletteCommand {
        PaletteCommand(
            id: "end-silence", title: "End Silence", group: .action,
            systemImage: "bell",
            action: .attempt {
                switch await model.unsilence(occurrence) {
                case .ended: nil
                case .stillSilenced(let until):
                    "Its own silence ended, but another silence still mutes it until "
                        + "\(timeOrDate(until))."
                case .failed(let problem): "Couldn't end the silence: \(problem.detail)"
                }
            })
    }

    /// Asks for when, with the presets of the alert's Remind Me button (`ReminderButton`),
    /// and Cancel Reminder while one is pending.
    private func remindCommand(for occurrence: Occurrence?) -> PaletteCommand {
        var choices: [PaletteCommand] = []
        if let occurrence {
            choices = ReminderPreset.options(at: .now, calendar: .current).map { option in
                PaletteCommand(
                    id: "remind \(option.id)", title: option.preset.title,
                    detail: reminderTime(option.date), group: .action, systemImage: "alarm",
                    action: .attempt {
                        await reminderActions.remind(occurrence, option.date).map {
                            "Couldn't set the reminder: \($0.detail)"
                        }
                    })
            }
            if occurrence.remindAt != nil {
                choices.append(
                    PaletteCommand(
                        id: "cancel-reminder", title: "Cancel Reminder", group: .action,
                        systemImage: "alarm",
                        action: .attempt {
                            await reminderActions.cancel(occurrence).map {
                                "Couldn't cancel the reminder: \($0.detail)"
                            }
                        }))
            }
        }
        return PaletteCommand(
            id: "remind", title: occurrence?.remindAt == nil ? "Remind Me…" : "Change Reminder…",
            detail: occurrence?.alert.title, group: .action, systemImage: "alarm",
            shortcut: .remindMe, unavailable: occurrence == nil ? "No alert open" : nil,
            action: .choose(
                prompt: "Bring it back as unread, for everyone using this server…",
                from: choices))
    }

    /// The window's reminders, as its buttons have them in the environment. An alert opened
    /// from Home is held apart from the lists, so it takes the server's answer here.
    var reminderActions: ReminderActions {
        ReminderActions(model) { if revealed?.id == $0.id { revealed = $0 } }
    }

    /// Search, and on Live the way back to the latest, which is choosing Live again.
    private var windowCommands: [PaletteCommand] {
        let search = PaletteCommand(
            id: "search", title: "Search Alerts", group: .action,
            systemImage: "magnifyingglass", shortcut: .search,
            action: .run { searchFocusRequests += 1 })
        guard activeSearch == nil, page == .list(.allChannels) else { return [search] }
        return [
            search,
            PaletteCommand(
                id: "live-latest", title: "Back to the Latest", detail: "Live", group: .action,
                systemImage: "arrow.up.to.line", shortcut: .back,
                action: go(to: .list(.allChannels))),
        ]
    }
}
