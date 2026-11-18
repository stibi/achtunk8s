import AchtungDomain
import Foundation
import Testing

private let installed = "/Users/someone/Applications/Achtung.app"
private let update = AvailableUpdate(
    version: "4f2a9c1", build: "431", published: Fixture.start, size: 3_708_092)

private func availability(
    debug: Bool = false, build: String = "430", key: String = "c2lnbmVk", path: String = installed
) -> UpdaterAvailability {
    UpdaterAvailability(isDebugBuild: debug, build: build, publicKey: key, bundlePath: path)
}

/// The state after these events, from idle.
private func state(after events: UpdateEvent...) -> UpdateState {
    events.reduce(.idle) { $0.after($1) }
}

// MARK: - Whether the updater runs

@Test func aReleaseBuildWithAKeyAndABuildNumberUpdatesItself() {
    #expect(availability() == .active)
    #expect(availability().reason == nil)
}

@Test func aDevelopmentBuildNeverUpdatesItself() {
    #expect(availability(debug: true) == .developmentBuild)
    // Xcode, run.sh and check.sh build number 0.
    #expect(availability(build: "0") == .developmentBuild)
    #expect(availability(build: "") == .developmentBuild)
    // Also when everything else is wrong too: it's the reason shown.
    #expect(
        availability(debug: true, key: "", path: "/private/var/T/AppTranslocation/X/d/Achtung.app")
            == .developmentBuild)
}

@Test func aBuildWithoutThePublicKeyHasNoUpdates() {
    #expect(availability(key: "") == .notConfigured)
    #expect(availability(key: "  ") == .notConfigured)
    #expect(availability(key: "").reason == "Updates aren't set up in this build.")
}

@Test func aTranslocatedAppCantUpdateAndSaysWhy() {
    let translocated = availability(
        path: "/private/var/folders/gl/x/T/AppTranslocation/B5ADC162/d/Achtung.app")
    #expect(translocated == .translocated)
    #expect(translocated.reason == UpdateFailure.translocated.explanation)
}

// MARK: - The updater's errors

@Test func aFeedWithABadSignatureIsTamperingNotAHiccup() {
    // Sparkle 2.10.1: SUAppcastParseError over the verifier's SUValidationError.
    let failure = UpdateFailure(
        sparkleCodes: [1000, 3002], message: "The update feed is improperly signed…")
    #expect(failure == .improperlySigned(.feed))
    #expect(!failure.canRetry)
    #expect(failure.title == "Update Rejected")
    #expect(failure.explanation.contains("feed"))
}

@Test func anUpdateWithABadSignatureIsTamperingNotAHiccup() {
    // Sparkle 2.10.1: SUInstallationError over the installer's error over SUValidationError.
    let failure = UpdateFailure(
        sparkleCodes: [4005, 4005, 3002], message: "The update is improperly signed…")
    #expect(failure == .improperlySigned(.update))
    #expect(!failure.canRetry)
    #expect(failure.explanation.contains("downloaded update"))
    #expect(UpdateFailure(sparkleCodes: [3001], message: "") == .improperlySigned(.update))
}

@Test func aFeedThatDoesntParseIsAnOrdinaryFailure() {
    let failure = UpdateFailure(sparkleCodes: [1000], message: "The feed couldn't be read.")
    #expect(failure == .other("The feed couldn't be read."))
    #expect(failure.canRetry)
    #expect(failure.title == "Update Failed")
    #expect(failure.explanation == "The feed couldn't be read.")
}

@Test func anErrorThatIsntSparklesIsShownInItsOwnWords() {
    #expect(
        UpdateFailure(sparkleCodes: [], message: "The Internet connection appears to be offline.")
            == .other("The Internet connection appears to be offline."))
}

@Test func sparklesOwnTranslocationErrorIsTheSameFailure() {
    #expect(UpdateFailure(sparkleCodes: [1005], message: "") == .translocated)
    #expect(!UpdateFailure.translocated.canRetry)
}

// MARK: - The states

@Test func anUpdateGoesFromFoundThroughDownloadToInstalling() {
    #expect(state(after: .checking) == .checking)
    #expect(state(after: .checking, .found(update)) == .available(update))
    #expect(
        state(after: .found(update), .downloadStarted) == .downloading(received: 0, expected: nil))
    #expect(
        state(
            after: .downloadStarted, .downloadExpects(bytes: 1000), .downloaded(bytes: 250),
            .downloaded(bytes: 250)) == .downloading(received: 500, expected: 1000))
    #expect(
        state(after: .downloadStarted, .extracting(progress: 0.4)) == .extracting(progress: 0.4))
    #expect(state(after: .extracting(progress: 1), .installing) == .installing)
    #expect(state(after: .installing, .dismissed) == .idle)
}

@Test func theLengthCanArriveAfterTheFirstBytes() {
    #expect(
        state(after: .downloadStarted, .downloaded(bytes: 100), .downloadExpects(bytes: 400))
            == .downloading(received: 100, expected: 400))
}

@Test func progressOutsideADownloadIsIgnored() {
    #expect(state(after: .downloaded(bytes: 100)) == .idle)
    #expect(state(after: .found(update), .downloadExpects(bytes: 100)) == .available(update))
    #expect(
        state(after: .downloadStarted, .dismissed, .downloaded(bytes: 100)) == .idle)
}

@Test func nothingNewerIsUpToDateAndPasses() {
    #expect(state(after: .checking, .notFound) == .upToDate)
    #expect(UpdateState.upToDate.isPassing)
    #expect(!UpdateState.available(update).isPassing)
    #expect(!UpdateState.failed(.improperlySigned(.feed)).isPassing)
}

@Test func aFailureStaysUntilDismissed() {
    let failed = state(after: .checking, .failed(.improperlySigned(.update)))
    #expect(failed == .failed(.improperlySigned(.update)))
    #expect(failed.after(.dismissed) == .idle)
}

@Test func progressIsKnownOnceTheLengthIs() {
    #expect(UpdateState.downloading(received: 10, expected: nil).progress == nil)
    #expect(UpdateState.downloading(received: 10, expected: 0).progress == nil)
    #expect(UpdateState.downloading(received: 250, expected: 1000).progress == 0.25)
    // A server can send more than it announced.
    #expect(UpdateState.downloading(received: 1200, expected: 1000).progress == 1)
    #expect(state(after: .extracting(progress: 1.7)) == .extracting(progress: 1))
    #expect(state(after: .extracting(progress: -1)) == .extracting(progress: 0))
    #expect(UpdateState.available(update).progress == nil)
}

@Test func thePillSaysWhereTheUpdateStands() {
    #expect(UpdateState.idle.label == nil)
    #expect(UpdateState.checking.label == "Checking for Updates…")
    #expect(UpdateState.available(update).label == "Update Available")
    #expect(UpdateState.downloading(received: 0, expected: nil).label == "Downloading…")
    #expect(UpdateState.downloading(received: 333, expected: 1000).label == "Downloading… 33%")
    #expect(UpdateState.extracting(progress: 0.5).label == "Preparing… 50%")
    #expect(UpdateState.installing.label == "Installing…")
    #expect(UpdateState.upToDate.label == "Up to Date")
    #expect(UpdateState.failed(.improperlySigned(.feed)).label == "Update Rejected")
    #expect(UpdateState.failed(.translocated).label == "Can't Update from Here")
    #expect(UpdateState.failed(.other("offline")).label == "Update Failed")
}

// MARK: - What changed

@Test func theChangesAreTheCommitsBetweenTheTwoBuilds() {
    #expect(
        update.changes(since: "13c8d67")?.absoluteString
            == "https://github.com/stibi/achtunk8s/compare/13c8d67...4f2a9c1")
}

@Test func aLocalBuildLinksToTheUpdatesCommit() {
    for local in ["dev", "13c8d67-dirty", ""] {
        #expect(
            update.changes(since: local)?.absoluteString
                == "https://github.com/stibi/achtunk8s/commit/4f2a9c1")
    }
}

@Test func anUpdateThatIsntACommitHasNoLink() {
    let named = AvailableUpdate(version: "spike-2", build: "100001", published: nil, size: nil)
    #expect(named.changes(since: "13c8d67") == nil)
}
