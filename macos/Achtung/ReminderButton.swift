import AchtungAPI
import AchtungDomain
import SwiftUI

/// What can be done about an occurrence's reminder (ADR 0025): set it for a time, which
/// replaces one it has, or cancel it. Each returns why it failed. The inbox puts these in
/// the environment, so the buttons and menus that remind don't each need them passed down.
struct ReminderActions: Sendable {
    let remind: @MainActor (Occurrence, Date) async -> ServerError?
    let cancel: @MainActor (Occurrence) async -> ServerError?

    /// `changed` gets the occurrence as the server returned it: the inbox's lists have it
    /// already, a copy held elsewhere (an alert opened from Home) doesn't.
    @MainActor
    init(_ model: InboxModel, changed: @escaping @MainActor (Occurrence) -> Void) {
        remind = { await Self.problem(model.remind($0, at: $1), changed) }
        cancel = { await Self.problem(model.cancelReminder($0), changed) }
    }

    @MainActor
    private static func problem(
        _ result: Result<Occurrence, ServerError>, _ changed: @MainActor (Occurrence) -> Void
    ) -> ServerError? {
        switch result {
        case .success(let occurrence):
            changed(occurrence)
            return nil
        case .failure(let error):
            return error
        }
    }

    init(
        remind: @escaping @MainActor (Occurrence, Date) async -> ServerError?,
        cancel: @escaping @MainActor (Occurrence) async -> ServerError?
    ) {
        self.remind = remind
        self.cancel = cancel
    }

    /// For previews: nothing happens.
    static let none = ReminderActions(remind: { _, _ in nil }, cancel: { _ in nil })
}

extension EnvironmentValues {
    @Entry var reminders = ReminderActions.none
}

/// "Remind Me": opens the times to choose from. With a reminder pending it says when, and
/// its popover changes or cancels it. With `hasShortcut`, ⇧⌘R opens it: only the one
/// detail pane has it, not each of Live's cards.
struct ReminderButton: View {
    let occurrence: Occurrence
    var hasShortcut = false

    @Environment(\.reminders) private var actions
    @State private var isChoosing = false
    @State private var isBusy = false
    @State private var problem: ServerError?

    var body: some View {
        HStack(spacing: 8) {
            Button {
                isChoosing.toggle()
            } label: {
                if let remindAt = occurrence.remindAt {
                    Label("Reminder \(reminderTime(remindAt))", systemImage: "alarm.fill")
                } else {
                    Label(isBusy ? "Setting…" : "Remind Me", systemImage: "alarm")
                }
            }
            .buttonStyle(.bordered)
            .shortcut(.remindMe, isActive: hasShortcut)
            .disabled(isBusy)
            .help(
                "Bring this alert back as unread at a time you choose, for everyone using this "
                    + "server" + (hasShortcut ? " (\(Shortcut.remindMe.symbols))" : "")
            )
            .popover(isPresented: $isChoosing, arrowEdge: .bottom) {
                ReminderChooser(
                    pending: occurrence.remindAt,
                    choose: { date in change { await actions.remind(occurrence, date) } },
                    cancel: { change { await actions.cancel(occurrence) } })
            }
            if let problem {
                Label(problem.detail, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .help(problem.title)
            }
        }
    }

    /// One change at a time, busy from the click, like the silence button.
    private func change(_ change: @escaping @MainActor () async -> ServerError?) {
        isChoosing = false
        guard !isBusy else { return }
        isBusy = true
        problem = nil
        Task {
            problem = await change()
            isBusy = false
        }
    }
}

/// The popover's choices: the presets with the time each means now, a date and time to
/// pick, and Cancel Reminder while one is pending.
private struct ReminderChooser: View {
    let pending: Date?
    let choose: (Date) -> Void
    let cancel: () -> Void

    /// As the popover opened: the times don't move while it is being read.
    @State private var now = Date.now
    @State private var picked = ReminderPreset.suggestion(at: .now, calendar: .current)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(pending.map { "Reminder set for \(reminderTime($0))" } ?? "Remind Me")
                    .font(.headline)
                Text("The alert comes back as unread then, for everyone using this server.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 2) {
                let options = ReminderPreset.options(at: now, calendar: .current)
                ForEach(options) { option in
                    Button {
                        choose(option.date)
                    } label: {
                        HStack {
                            Text(option.preset.title)
                            Spacer(minLength: 16)
                            Text(reminderTime(option.date))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        .contentShape(.rect)
                    }
                    .buttonStyle(ReminderOptionStyle())
                    .accessibilityLabel("\(option.preset.title), \(reminderTime(option.date))")
                }
            }
            Divider()
            HStack {
                DatePicker(
                    "Pick date and time", selection: $picked, in: ReminderTime.range(at: now),
                    displayedComponents: [.date, .hourAndMinute]
                )
                .labelsHidden()
                Spacer()
                Button(pending == nil ? "Remind Me" : "Change") { choose(picked) }
                    .keyboardShortcut(.defaultAction)
            }
            if pending != nil {
                Divider()
                Button("Cancel Reminder", role: .destructive, action: cancel)
            }
        }
        .padding(14)
        .frame(width: 300)
    }
}

/// A preset's row in the popover: plain, with a highlight under the pointer.
private struct ReminderOptionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: Configuration
        @State private var isHovered = false

        var body: some View {
            configuration.label
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(
                    isHovered || configuration.isPressed
                        ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                    in: .rect(cornerRadius: 6)
                )
                .onHover { isHovered = $0 }
        }
    }
}

/// "Remind Me" in a row's context menu: the same presets, and Cancel Reminder while one
/// is pending. `failed` gets the reason when the server refuses.
struct ReminderMenuItems: View {
    let occurrence: Occurrence
    let failed: (String) -> Void

    @Environment(\.reminders) private var actions

    var body: some View {
        Menu(occurrence.remindAt == nil ? "Remind Me" : "Change Reminder") {
            ForEach(ReminderPreset.options(at: .now, calendar: .current)) { option in
                Button("\(option.preset.title) (\(reminderTime(option.date)))") {
                    Task {
                        if let problem = await actions.remind(occurrence, option.date) {
                            failed("Couldn't set the reminder: \(problem.detail)")
                        }
                    }
                }
            }
        }
        if occurrence.remindAt != nil {
            Button("Cancel Reminder") {
                Task {
                    if let problem = await actions.cancel(occurrence) {
                        failed("Couldn't cancel the reminder: \(problem.detail)")
                    }
                }
            }
        }
    }
}

/// "Reminder Thu 08:00" in the alert header, while one is pending.
struct ReminderPill: View {
    let date: Date

    var body: some View {
        Label("Reminder \(reminderTime(date))", systemImage: "alarm")
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(.secondary)
            .background(.quaternary, in: Capsule())
            .help("Comes back as unread then, for everyone using this server")
    }
}

/// "Reminder 14:05" in the alert header: a reminder came due, which made the alert unread
/// again. The accent colour, like the resend's pill.
struct RemindedPill: View {
    let date: Date

    var body: some View {
        Label("Reminder \(timeOrDate(date))", systemImage: "alarm.fill")
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .foregroundStyle(Color.accentColor)
            .background(Color.accentColor.opacity(0.15), in: Capsule())
            .help(Self.explanation)
    }

    static let explanation =
        "A reminder set on this alert came due. It isn't new: someone asked to get back to it."
}

/// A reminder's time, as short as says it: the time alone today, with the weekday within
/// a week, else with the date.
func reminderTime(_ date: Date, now: Date = .now) -> String {
    let calendar = Calendar.current
    if calendar.isDate(date, inSameDayAs: now) {
        return date.formatted(date: .omitted, time: .shortened)
    }
    let days = calendar.dateComponents(
        [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)
    ).day
    if let days, (1..<7).contains(days) {
        return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
    return date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
}
