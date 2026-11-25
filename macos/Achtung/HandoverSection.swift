import AchtungAPI
import AchtungDomain
import SwiftUI

/// What can be done about handovers (ADR 0022): hand an occurrence over to an action, or
/// cancel a handover. Each returns why it failed. The inbox puts these in the environment.
struct HandoverActions: Sendable {
    let handOver: @MainActor (Occurrence, ActionOffer) async -> ServerError?
    let cancel: @MainActor (Handover) async -> ServerError?

    @MainActor
    init(_ model: InboxModel) {
        handOver = { await model.handOver($0, to: $1) }
        cancel = { await model.cancel($0) }
    }

    init(
        handOver: @escaping @MainActor (Occurrence, ActionOffer) async -> ServerError?,
        cancel: @escaping @MainActor (Handover) async -> ServerError?
    ) {
        self.handOver = handOver
        self.cancel = cancel
    }

    /// For previews: nothing happens.
    static let none = HandoverActions(handOver: { _, _ in nil }, cancel: { _ in nil })
}

extension EnvironmentValues {
    @Entry var handovers = HandoverActions.none
}

/// What plugins offer to do with an alert, and what came of it (ADR 0022): a button per
/// action a handler offers, a card for the latest handover of each action, and the
/// earlier ones folded away. Nothing at all when no handler offers anything and nothing
/// was ever handed over.
struct HandoverSection: View {
    let occurrence: Occurrence
    let detail: OccurrenceDetail

    @Environment(\.handovers) private var actions
    @State private var isBusy = false
    @State private var problem: ServerError?

    var body: some View {
        if !detail.actions.isEmpty || !detail.handovers.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                if !detail.actions.isEmpty {
                    FlowLayout(spacing: 8) {
                        ForEach(detail.actions) { offer in
                            button(for: offer)
                        }
                    }
                }
                if let problem {
                    Label(problem.detail, systemImage: "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .help(problem.title)
                }
                ForEach(detail.latestHandovers) { handover in
                    HandoverCard(handover: handover)
                }
                earlier
            }
        }
    }

    private func button(for offer: ActionOffer) -> some View {
        Button {
            handOver(to: offer)
        } label: {
            Label(offer.title, systemImage: "sparkles")
        }
        .buttonStyle(.bordered)
        .disabled(isBusy || !offer.isAvailable || detail.activeHandover(of: offer) != nil)
        .help(help(for: offer))
    }

    /// The action's own description, by whom, and why the button is off when it is.
    private func help(for offer: ActionOffer) -> String {
        var lines = [offer.description, "Handed to \(offer.handlerName), a plugin of this server."]
        if !offer.isAvailable {
            let seen = offer.lastSeenAt.formatted(date: .abbreviated, time: .shortened)
            lines.append("\(offer.handlerName) hasn't connected since \(seen).")
        } else if detail.activeHandover(of: offer) != nil {
            lines.append("It is working on this alert already.")
        }
        return lines.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    @ViewBuilder private var earlier: some View {
        let handovers = detail.earlierHandovers
        if !handovers.isEmpty {
            DisclosureGroup("Earlier handovers (\(handovers.count))") {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(handovers) { handover in
                        HandoverCard(handover: handover)
                    }
                }
                .padding(.top, 8)
            }
            .font(.callout)
        }
    }

    /// One at a time, busy from the click, like the silence button.
    private func handOver(to offer: ActionOffer) {
        guard !isBusy else { return }
        isBusy = true
        problem = nil
        Task {
            problem = await actions.handOver(occurrence, offer)
            isBusy = false
        }
    }
}
