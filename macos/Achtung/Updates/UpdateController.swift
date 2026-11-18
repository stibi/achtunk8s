// Adapted from Ghostty's macos/Sources/Features/Update/UpdateController.swift (MIT, ©
// Mitchell Hashimoto and Ghostty contributors): an `SPUUpdater` with a custom user driver.
// Different here: the updater exists only where an update can land (`UpdaterAvailability`).

import AchtungDomain
import Foundation
import Sparkle

/// The running app's version, as `install.sh` and the release build stamp it: the short
/// commit hash and the commit count. "dev" and "0" in a build from Xcode or `run.sh`.
struct AppVersion {
    static let current = AppVersion(bundle: .main)

    let version: String
    let build: String

    init(bundle: Bundle) {
        version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    }
}

/// In-app updates (ADR 0021): Sparkle checks the feed once a day and on "Check for
/// Updates…", and installs what the user accepts. The updater exists only when
/// `availability` is `active`: never in a Debug build (Xcode, `run.sh`, demo mode, previews,
/// tests), with build number 0, without a public key in the build, or translocated.
@Observable @MainActor
final class UpdateController {
    private enum Engine {
        case off
        case sparkle(SPUUpdater, UpdateDriver)
        #if DEBUG
            case simulated(UpdateSimulator)
        #endif
    }

    let availability: UpdaterAvailability
    let model = UpdateModel()
    /// Settings' "Check for updates automatically"; Sparkle keeps it in the defaults.
    var automaticallyChecks = false {
        didSet {
            if case .sparkle(let updater, _) = engine,
                updater.automaticallyChecksForUpdates != automaticallyChecks
            {
                updater.automaticallyChecksForUpdates = automaticallyChecks
            }
        }
    }

    @ObservationIgnored private var engine = Engine.off
    @ObservationIgnored private var showWindow: () -> Void = {}

    init() {
        let bundle = Bundle.main
        let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
        #if DEBUG
            // Demo mode's made-up update looks like the real thing, menu item and all.
            availability =
                UpdateSimulator.requested == nil
                ? UpdaterAvailability(
                    isDebugBuild: true, build: AppVersion(bundle: bundle).build,
                    publicKey: publicKey, bundlePath: bundle.bundlePath)
                : .active
        #else
            availability = UpdaterAvailability(
                isDebugBuild: false, build: AppVersion(bundle: bundle).build,
                publicKey: publicKey, bundlePath: bundle.bundlePath)
        #endif
    }

    /// "Check for Updates…" does something: it checks, or says why an update can't land.
    var canCheck: Bool {
        availability == .active || availability == .translocated
    }

    /// Once, at launch. `showWindow` brings the main window back, for what the pill shows.
    func start(showWindow: @escaping () -> Void) {
        self.showWindow = showWindow
        model.checkAgain = { [weak self] in self?.checkForUpdates() }
        #if DEBUG
            if let scenario = UpdateSimulator.requested {
                let simulator = UpdateSimulator(scenario, model: model)
                engine = .simulated(simulator)
                simulator.run()
                return
            }
        #endif
        switch availability {
        case .active:
            startSparkle()
        case .translocated:
            // Said at launch, quietly in the pill: otherwise this copy would stay as it is
            // without anyone noticing.
            model.show(.failed(.translocated))
        case .developmentBuild, .notConfigured:
            break
        }
    }

    func checkForUpdates() {
        switch engine {
        case .sparkle(let updater, _):
            // "Up to Date" or a failure on screen still holds the last check open; closing
            // it takes the updater a moment.
            if model.state.isPassing || model.state.isFailed {
                model.dismiss()
                Task {
                    // Up to 3 seconds: afterwards the updater says itself what is going on.
                    for _ in 0..<30 where !updater.canCheckForUpdates {
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                    updater.checkForUpdates()
                }
            } else {
                updater.checkForUpdates()
            }
        case .off:
            if availability == .translocated {
                showWindow()
                model.show(.failed(.translocated), details: true)
            } else if availability == .active {
                // The updater didn't start at launch, and said so: try that again.
                showWindow()
                model.dismiss()
                startSparkle()
                if case .sparkle(let updater, _) = engine {
                    updater.checkForUpdates()
                }
            }
        #if DEBUG
            case .simulated(let simulator):
                showWindow()
                simulator.run()
        #endif
        }
    }

    private func startSparkle() {
        let driver = UpdateDriver(model: model, hostBundle: .main) { [weak self] in
            self?.showWindow()
        }
        let updater = SPUUpdater(
            hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: nil)
        do {
            try updater.start()
        } catch {
            // A broken build (Info.plist keys that contradict each other), not the user's
            // doing: say it in the pill. "Check for Updates…" tries again.
            model.show(.failed(.other(error.localizedDescription)))
            return
        }
        engine = .sparkle(updater, driver)
        automaticallyChecks = updater.automaticallyChecksForUpdates
    }
}

extension UpdateState {
    fileprivate var isFailed: Bool {
        if case .failed = self { true } else { false }
    }
}
