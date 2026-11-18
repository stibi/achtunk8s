// Adapted from Ghostty's macos/Sources/Features/Update/UpdateDriver.swift (MIT, © Mitchell
// Hashimoto and Ghostty contributors): a custom Sparkle user driver that shows updates
// unobtrusively in the window and hands over to Sparkle's standard dialogs when there is no
// window. Different here: the state is plain data in AchtungDomain with the updater's
// pending answer kept apart, one presenter per session instead of both at once, and
// failed signature checks told apart from other errors.

import AchtungDomain
import AppKit
import OSLog
import Sparkle

/// Sparkle's user interface (ADR 0021). While the main window is open, an update shows as
/// the toolbar's pill (`UpdateModel`); without one, Sparkle's standard dialogs take over.
/// Whoever shows the first step of a check shows it to its end.
@MainActor
final class UpdateDriver: NSObject, SPUUserDriver {
    private enum Presenter {
        case pill
        case standard
    }

    private static let log = Logger(subsystem: "io.github.stibi.achtung", category: "updates")

    private let model: UpdateModel
    private let standard: SPUStandardUserDriver
    private let showWindow: () -> Void
    /// Who shows the check in progress; nil between checks.
    private var presenter: Presenter?

    init(model: UpdateModel, hostBundle: Bundle, showWindow: @escaping () -> Void) {
        self.model = model
        self.standard = SPUStandardUserDriver(hostBundle: hostBundle, delegate: nil)
        self.showWindow = showWindow
    }

    /// For the steps a check can begin with: the pill when the main window is open as it
    /// begins. Later steps only read `showsInPill`, so progress that arrives after a
    /// cancelled check doesn't pick a presenter for the next one.
    private func beginsInPill() -> Bool {
        if presenter == nil {
            let hasWindow = NSApp.windows.contains { $0.isMainAchtungWindow && $0.isVisible }
            presenter = hasWindow ? .pill : .standard
        }
        return showsInPill
    }

    private var showsInPill: Bool { presenter == .pill }

    /// An answer that ends the check, so the next one picks its presenter afresh.
    private func ending(_ answer: @escaping () -> Void) -> () -> Void {
        { [weak self] in
            self?.presenter = nil
            answer()
        }
    }

    private func ending(
        _ reply: @escaping (SPUUserUpdateChoice) -> Void
    ) -> (SPUUserUpdateChoice) -> Void {
        { [weak self] choice in
            if choice != .install {
                self?.presenter = nil
            }
            reply(choice)
        }
    }

    // MARK: - Checking

    /// Never asked: `SUEnableAutomaticChecks` is set in Info.plist. Answered as that says,
    /// without a system profile.
    func show(
        _ request: SPUUpdatePermissionRequest,
        reply: @escaping (SUUpdatePermissionResponse) -> Void
    ) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        if beginsInPill() {
            // The user asked, perhaps from the menu bar with the window behind another app.
            showWindow()
            model.show(.checking, reply: .cancel(ending(cancellation)))
        } else {
            standard.showUserInitiatedUpdateCheck(cancellation: ending(cancellation))
        }
    }

    func showUpdateFound(
        with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
        reply: @escaping (SPUUserUpdateChoice) -> Void
    ) {
        // A notice without a download (Achtung publishes none) is Sparkle's to show.
        if appcastItem.isInformationOnlyUpdate {
            model.show(.dismissed, reply: .nothing)
            presenter = .standard
        }
        guard beginsInPill() else {
            standard.showUpdateFound(with: appcastItem, state: state, reply: ending(reply))
            return
        }
        let reply = ending(reply)
        let update = AvailableUpdate(
            version: appcastItem.displayVersionString, build: appcastItem.versionString,
            published: appcastItem.date,
            size: appcastItem.contentLength > 0 ? appcastItem.contentLength : nil)
        model.show(
            .found(update),
            reply: .choice { choice in
                switch choice {
                case .install: reply(.install)
                case .skip: reply(.skip)
                case .later: reply(.dismiss)
                }
            },
            // Only when the user asked; a scheduled check shows the pill alone.
            details: state.userInitiated)
    }

    /// Achtung's feed has no release notes; the popover links to the commits on GitHub.
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}

    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}

    func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        if beginsInPill() {
            model.show(.notFound, reply: .acknowledge(ending(acknowledgement)))
        } else {
            standard.showUpdateNotFoundWithError(error, acknowledgement: ending(acknowledgement))
        }
    }

    func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        let codes = Self.sparkleCodes(of: error)
        let message = Self.message(of: error)
        Self.log.error("Update failed, Sparkle errors \(codes, privacy: .public): \(message)")
        if beginsInPill() {
            let failure = UpdateFailure(sparkleCodes: codes, message: message)
            model.show(
                .failed(failure), reply: .acknowledge(ending(acknowledgement)), details: true)
        } else {
            standard.showUpdaterError(error, acknowledgement: ending(acknowledgement))
        }
    }

    // MARK: - Downloading and installing

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        if showsInPill {
            model.show(.downloadStarted, reply: .cancel(ending(cancellation)))
        } else {
            standard.showDownloadInitiated(cancellation: ending(cancellation))
        }
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        if showsInPill {
            model.show(.downloadExpects(bytes: expectedContentLength))
        } else if presenter == .standard {
            standard.showDownloadDidReceiveExpectedContentLength(expectedContentLength)
        }
    }

    func showDownloadDidReceiveData(ofLength length: UInt64) {
        if showsInPill {
            model.show(.downloaded(bytes: length))
        } else if presenter == .standard {
            standard.showDownloadDidReceiveData(ofLength: length)
        }
    }

    func showDownloadDidStartExtractingUpdate() {
        if showsInPill {
            model.show(.extracting(progress: 0), reply: .nothing)
        } else {
            standard.showDownloadDidStartExtractingUpdate()
        }
    }

    func showExtractionReceivedProgress(_ progress: Double) {
        if showsInPill {
            model.show(.extracting(progress: progress))
        } else if presenter == .standard {
            standard.showExtractionReceivedProgress(progress)
        }
    }

    /// In the pill the user already chose Install and Relaunch, so it goes on.
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        if showsInPill {
            reply(.install)
        } else {
            standard.showReady(toInstallAndRelaunch: ending(reply))
        }
    }

    func showInstallingUpdate(
        withApplicationTerminated applicationTerminated: Bool,
        retryTerminatingApplication: @escaping () -> Void
    ) {
        if showsInPill {
            model.show(.installing, reply: .relaunch(retryTerminatingApplication))
        } else {
            standard.showInstallingUpdate(
                withApplicationTerminated: applicationTerminated,
                retryTerminatingApplication: retryTerminatingApplication)
        }
    }

    /// Only shown when the update was installed without relaunching Achtung.
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void)
    {
        model.show(.dismissed, reply: .nothing)
        standard.showUpdateInstalledAndRelaunched(
            relaunched, acknowledgement: ending(acknowledgement))
    }

    /// "Check for Updates…" while one is shown: bring it to the front.
    func showUpdateInFocus() {
        if showsInPill {
            showWindow()
            model.showsDetails = true
        } else {
            standard.showUpdateInFocus()
        }
    }

    func dismissUpdateInstallation() {
        presenter = nil
        model.show(.dismissed, reply: .nothing)
        standard.dismissUpdateInstallation()
    }

    // MARK: - Errors

    /// The codes of the error's Sparkle errors: its own, then each underlying one.
    private static func sparkleCodes(of error: any Error) -> [Int] {
        var codes: [Int] = []
        var next: NSError? = error as NSError
        while let current = next {
            if current.domain == SUSparkleErrorDomain {
                codes.append(current.code)
            }
            next = current.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return codes
    }

    private static func message(of error: any Error) -> String {
        let error = error as NSError
        return [error.localizedDescription, error.localizedRecoverySuggestion]
            .compactMap(\.self)
            .joined(separator: " ")
    }
}
