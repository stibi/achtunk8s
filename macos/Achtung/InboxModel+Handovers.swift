import AchtungAPI
import AchtungDomain
import Foundation

/// The handovers this Mac asked for and hasn't seen end (ADR 0022), with the alert each is
/// about: when one ends, this Mac is told, and no other. Kept in memory; quitting forgets
/// them, and the alert still shows the result.
@MainActor
final class HandoverWatch {
    var pending: [Int: String] = [:]
    /// Called with a handover of this Mac's that ended, and its alert's title.
    var onEnded: (Handover, String) -> Void = { _, _ in }
}

extension NotificationSetting {
    /// Whether a handover this Mac asked for is announced when it ends; on unless turned off.
    static let handoversKey = "notifyHandovers"
}

// Handing an alert over to a plugin (ADR 0022): ask, cancel, and follow what comes back.
extension InboxModel {
    /// Hands the occurrence over to a handler's action, and shows the handover in its
    /// detail. Returns why it failed, e.g. the handler isn't connected any more.
    func handOver(_ occurrence: Occurrence, to offer: ActionOffer) async -> ServerError? {
        do throws(ServerError) {
            let handover = try await server.handOver(occurrenceID: occurrence.id, to: offer)
            if handover.isActive {
                handoverWatch.pending[handover.id] = occurrence.alert.title
            }
            await reloadDetail(ofOccurrence: occurrence.id)
            return nil
        } catch {
            // The detail may be why: an action no longer offered, a handler gone.
            await reloadDetail(ofOccurrence: occurrence.id)
            return error
        }
    }

    /// Cancels a handover that is requested or running. Returns why it failed.
    func cancel(_ handover: Handover) async -> ServerError? {
        var problem: ServerError?
        do throws(ServerError) {
            _ = try await server.cancelHandover(id: handover.id)
            // Cancelled here: nothing to be told about.
            handoverWatch.pending[handover.id] = nil
        } catch {
            problem = error
        }
        await reloadDetail(ofOccurrence: handover.occurrenceID)
        return problem
    }

    /// Whether anything about handovers is worth asking the server for: one on screen that
    /// may still move, or one of this Mac's that hasn't ended.
    var followsHandovers: Bool {
        !handoverWatch.pending.isEmpty || detail?.handovers.contains(where: \.isActive) == true
    }

    /// The server said handovers or the actions offered changed (ADR 0019), or it is time
    /// to look: reads the open alert's again, and tells of this Mac's handovers that ended.
    func handoversChanged() async {
        if let shown = detail?.occurrence {
            await reloadDetail(ofOccurrence: shown.id)
        }
        for (id, title) in handoverWatch.pending {
            // One that can't be read now is asked for again next time.
            guard let handover = try? await server.handover(id: id), !handover.isActive else {
                continue
            }
            handoverWatch.pending[id] = nil
            handoverWatch.onEnded(handover, title)
        }
    }

    /// Reads the open detail again, if it is still this occurrence's.
    private func reloadDetail(ofOccurrence id: Int) async {
        if let shown = detail?.occurrence, shown.id == id {
            await loadDetail(of: shown)
        }
    }
}
