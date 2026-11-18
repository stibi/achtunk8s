// The idea is Ghostty's macos/Sources/Features/Update/UpdateSimulator.swift (MIT, © Mitchell
// Hashimoto and Ghostty contributors): play the updater's states without a feed.

#if DEBUG
    import AchtungDomain
    import Foundation

    /// A made-up update for demo mode and screenshots, in Debug builds only, where the real
    /// updater never runs: `macos/scripts/demo.sh -simulateUpdate available` (or
    /// `up-to-date`, `tampered-update`, `tampered-feed`, `failed`, `translocated`). It
    /// plays at launch and again on "Check for Updates…". Nothing is fetched or installed.
    @MainActor
    final class UpdateSimulator {
        enum Scenario: String {
            /// Found; Install and Relaunch then plays the download to "Installing…".
            case available
            case upToDate = "up-to-date"
            case tamperedUpdate = "tampered-update"
            case tamperedFeed = "tampered-feed"
            case failed
            case translocated
        }

        /// The launch argument, read through the defaults: `-simulateUpdate available`.
        private static let argument = "simulateUpdate"

        private let model: UpdateModel
        private let scenario: Scenario
        private var playing: Task<Void, Never>?

        /// The scenario the app was started with, if any.
        static var requested: Scenario? {
            UserDefaults.standard.string(forKey: argument).flatMap(Scenario.init(rawValue:))
        }

        init(_ scenario: Scenario, model: UpdateModel) {
            self.model = model
            self.scenario = scenario
        }

        func run() {
            play {
                self.model.show(.checking, reply: .cancel { self.playing?.cancel() })
                try await Task.sleep(for: .seconds(1))
                self.finishCheck()
            }
        }

        private func finishCheck() {
            let acknowledge = UpdateModel.Reply.acknowledge {}
            switch scenario {
            case .available:
                let update = AvailableUpdate(
                    version: "4f2a9c1", build: "431", published: .now.addingTimeInterval(-2 * 3600),
                    size: 3_708_092)
                model.show(
                    .found(update),
                    reply: .choice { choice in
                        if choice == .install {
                            self.install(update)
                        }
                    }, details: true)
            case .upToDate:
                model.show(.notFound, reply: acknowledge)
            case .tamperedUpdate:
                model.show(.failed(.improperlySigned(.update)), reply: acknowledge, details: true)
            case .tamperedFeed:
                model.show(.failed(.improperlySigned(.feed)), reply: acknowledge, details: true)
            case .failed:
                model.show(
                    .failed(.other("The Internet connection appears to be offline.")),
                    reply: acknowledge, details: true)
            case .translocated:
                model.show(.failed(.translocated), reply: acknowledge, details: true)
            }
        }

        private func install(_ update: AvailableUpdate) {
            play {
                let size = update.size ?? 0
                self.model.show(.downloadStarted, reply: .cancel { self.playing?.cancel() })
                self.model.show(.downloadExpects(bytes: size))
                for _ in 1...10 {
                    try await Task.sleep(for: .milliseconds(200))
                    self.model.show(.downloaded(bytes: size / 10))
                }
                for step in 0...5 {
                    self.model.show(.extracting(progress: Double(step) / 5), reply: .nothing)
                    try await Task.sleep(for: .milliseconds(200))
                }
                // The real updater quits Achtung here; the demo just ends.
                self.model.show(
                    .installing, reply: .relaunch { self.model.show(.dismissed, reply: .nothing) })
            }
        }

        /// One scene at a time; cancelling it (the pill's Cancel) stops it where it is.
        private func play(_ scene: @escaping @MainActor () async throws -> Void) {
            playing?.cancel()
            playing = Task {
                try? await scene()
            }
        }
    }
#endif
