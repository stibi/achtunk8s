import AchtungDomain
import Foundation

/// What the user answers to an update that was found.
enum UpdateChoice {
    case install
    case skip
    case later
}

/// The update the toolbar's pill and its popover show (ADR 0021): the state
/// (`UpdateState` in AchtungDomain) and the one answer the updater waits for in it. The
/// updater's driver (`UpdateDriver`), or the simulator in demo mode, reports here; the
/// views read the state and answer through the methods.
@Observable @MainActor
final class UpdateModel {
    /// What the updater waits for in the current state. It takes one answer at a time.
    enum Reply {
        case nothing
        case choice((UpdateChoice) -> Void)
        case cancel(() -> Void)
        case acknowledge(() -> Void)
        case relaunch(() -> Void)
    }

    /// How long "Up to Date" stays before it goes away by itself.
    private static let passingTime = Duration.seconds(5)

    private(set) var state: UpdateState = .idle
    /// Whether the pill's popover is open.
    var showsDetails = false
    /// Checks again, after a failure; set by `UpdateController`.
    @ObservationIgnored var checkAgain: () -> Void = {}

    @ObservationIgnored private var reply = Reply.nothing
    @ObservationIgnored private var passing: Task<Void, Never>?

    /// The updater reports `event`. A `reply` replaces the answer it waits for; nil keeps
    /// it, for progress within a state. `details` opens the popover, for what the user
    /// asked for themselves.
    func show(_ event: UpdateEvent, reply: Reply? = nil, details: Bool = false) {
        state = state.after(event)
        if let reply {
            self.reply = reply
        }
        if state == .idle {
            showsDetails = false
        } else if details {
            showsDetails = true
        }
        passing?.cancel()
        passing = nil
        if state.isPassing {
            passing = Task { [weak self] in
                try? await Task.sleep(for: Self.passingTime)
                if !Task.isCancelled {
                    self?.dismiss()
                }
            }
        }
    }

    /// Install and Relaunch, Skip or Later on an available update. Installing continues
    /// with the download; the other two end it.
    func choose(_ choice: UpdateChoice) {
        guard case .choice(let answer) = take() else { return }
        showsDetails = false
        if choice != .install {
            show(.dismissed)
        }
        answer(choice)
    }

    /// Stops a check or a download.
    func cancel() {
        guard case .cancel(let cancel) = take() else { return }
        show(.dismissed)
        cancel()
    }

    /// Closes "Up to Date" or a failure, which lets the updater check again.
    func dismiss() {
        let reply = take()
        show(.dismissed)
        if case .acknowledge(let acknowledge) = reply {
            acknowledge()
        }
    }

    /// Asks Achtung to quit again for an update that waits for it. The answer stays: it
    /// can be asked more than once.
    func relaunch() {
        if case .relaunch(let relaunch) = reply {
            relaunch()
        }
    }

    /// Each answer is given once.
    private func take() -> Reply {
        defer { reply = .nothing }
        return reply
    }
}
