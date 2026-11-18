import Foundation

/// Whether this copy of Achtung updates itself (ADR 0021), and if not, why. Decided once
/// at launch; the updater only ever starts when it's `active`.
public enum UpdaterAvailability: Sendable, Hashable {
    case active
    /// A Debug build, or one without a build number (Xcode, `run.sh`, demo mode,
    /// `check.sh`): it must never replace itself with a published build.
    case developmentBuild
    /// Built without the public key that updates are verified with.
    case notConfigured
    /// macOS runs the app from a temporary read-only copy (app translocation), where an
    /// update can't land.
    case translocated

    /// `publicKey` is `SUPublicEDKey` and `build` is `CFBundleVersion`, as the bundle has
    /// them; `bundlePath` is where the running app is.
    public init(isDebugBuild: Bool, build: String, publicKey: String, bundlePath: String) {
        let build = build.trimmingCharacters(in: .whitespaces)
        if isDebugBuild || build.isEmpty || build == "0" {
            self = .developmentBuild
        } else if publicKey.trimmingCharacters(in: .whitespaces).isEmpty {
            self = .notConfigured
        } else if bundlePath.contains("/AppTranslocation/") {
            self = .translocated
        } else {
            self = .active
        }
    }

    /// Why Achtung doesn't update itself, for the menu item and Settings; nil when it does.
    public var reason: String? {
        switch self {
        case .active: nil
        case .developmentBuild: "Development builds don't update themselves."
        case .notConfigured: "Updates aren't set up in this build."
        case .translocated: UpdateFailure.translocated.explanation
        }
    }
}

/// A newer build the feed offers.
public struct AvailableUpdate: Sendable, Hashable {
    /// The short commit hash it was built from.
    public let version: String
    /// The build number: the commit count of `main`.
    public let build: String
    public let published: Date?
    /// The download's size in bytes; nil when the feed doesn't say.
    public let size: UInt64?

    public init(version: String, build: String, published: Date?, size: UInt64?) {
        self.version = version
        self.build = build
        self.published = published
        self.size = size
    }

    /// What changed, on GitHub: everything between the running build and this one, or
    /// this build's commit when the running version isn't a commit hash (a local build).
    /// Nil when this update's version isn't one either.
    public func changes(since current: String) -> URL? {
        guard Self.isCommitHash(version) else { return nil }
        let repository = "https://github.com/stibi/achtunk8s"
        return Self.isCommitHash(current)
            ? URL(string: "\(repository)/compare/\(current)...\(version)")
            : URL(string: "\(repository)/commit/\(version)")
    }

    private static func isCommitHash(_ version: String) -> Bool {
        (7...40).contains(version.count) && version.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

/// Why an update didn't happen.
public enum UpdateFailure: Sendable, Hashable {
    /// What failed its signature check.
    public enum Signed: Sendable, Hashable {
        case feed
        case update
    }

    /// The feed or the download isn't signed with Achtung's key. With ad-hoc code signing
    /// that signature is the only protection (ADR 0021), so this means tampering or a
    /// broken release, never "try later".
    case improperlySigned(Signed)
    case translocated
    /// Anything else (the network, the disk), in the updater's words.
    case other(String)

    /// From the updater's error: the codes of its Sparkle errors, the outermost first and
    /// then each underlying one, and its message. A failed signature check is a validation
    /// or signature error somewhere in the chain; it's the feed's when the outermost error
    /// is from reading the feed (1000 to 1999).
    public init(sparkleCodes: [Int], message: String) {
        let validationFailed = 3002
        let signatureFailed = 3001
        let runningTranslocated = 1005
        if sparkleCodes.contains(runningTranslocated) {
            self = .translocated
        } else if sparkleCodes.contains(validationFailed) || sparkleCodes.contains(signatureFailed)
        {
            let readingFeed = sparkleCodes.first.map { (1000..<2000).contains($0) } ?? false
            self = .improperlySigned(readingFeed ? .feed : .update)
        } else {
            self = .other(message)
        }
    }

    public var title: String {
        switch self {
        case .improperlySigned: "Update Rejected"
        case .translocated: "Can't Update from Here"
        case .other: "Update Failed"
        }
    }

    public var explanation: String {
        switch self {
        case .improperlySigned(.feed):
            "The update feed isn't signed with Achtung's key, so Achtung ignored it. Nothing "
                + "was downloaded or installed. Someone may have tampered with it: don't "
                + "install Achtung from this network until that's cleared up."
        case .improperlySigned(.update):
            "The downloaded update isn't signed with Achtung's key, so Achtung threw it away. "
                + "Nothing was installed. Someone may have tampered with it: don't install "
                + "Achtung from this network until that's cleared up."
        case .translocated:
            "macOS is running Achtung from a temporary read-only copy, because it was "
                + "downloaded and not yet approved where it is. An update can't be installed "
                + "there."
        case .other(let message):
            message
        }
    }

    /// Whether checking again could help. A failed signature check isn't a hiccup.
    public var canRetry: Bool {
        if case .other = self { true } else { false }
    }
}

/// What the updater reports while it checks, downloads and installs.
public enum UpdateEvent: Sendable, Hashable {
    case checking
    case found(AvailableUpdate)
    case notFound
    case downloadStarted
    case downloadExpects(bytes: UInt64)
    case downloaded(bytes: UInt64)
    case extracting(progress: Double)
    case installing
    case failed(UpdateFailure)
    /// The user dismissed what was shown, or the updater ended its session.
    case dismissed
}

/// Where an update stands: what the toolbar's pill shows. `idle` shows nothing.
public enum UpdateState: Sendable, Hashable {
    case idle
    case checking
    case available(AvailableUpdate)
    case downloading(received: UInt64, expected: UInt64?)
    /// `progress` from 0 to 1.
    case extracting(progress: Double)
    /// Downloaded and verified; installed as Achtung quits, which then relaunches.
    case installing
    case upToDate
    case failed(UpdateFailure)

    /// The state after `event`. Progress that arrives outside a download is ignored: the
    /// updater reports it late when a download was cancelled.
    public func after(_ event: UpdateEvent) -> UpdateState {
        switch event {
        case .checking: return .checking
        case .found(let update): return .available(update)
        case .notFound: return .upToDate
        case .downloadStarted: return .downloading(received: 0, expected: nil)
        case .downloadExpects(let bytes):
            return whileDownloading { received, _ in (received, bytes) }
        case .downloaded(let bytes):
            return whileDownloading { received, expected in (received + bytes, expected) }
        case .extracting(let progress): return .extracting(progress: min(1, max(0, progress)))
        case .installing: return .installing
        case .failed(let failure): return .failed(failure)
        case .dismissed: return .idle
        }
    }

    private func whileDownloading(
        _ change: (UInt64, UInt64?) -> (received: UInt64, expected: UInt64?)
    ) -> UpdateState {
        guard case .downloading(let received, let expected) = self else { return self }
        let changed = change(received, expected)
        return .downloading(received: changed.received, expected: changed.expected)
    }

    /// From 0 to 1 while downloading or extracting, when it's known.
    public var progress: Double? {
        switch self {
        case .downloading(let received, let expected?) where expected > 0:
            min(1, Double(received) / Double(expected))
        case .extracting(let progress): progress
        default: nil
        }
    }

    /// The pill's text; nil when there is nothing to show.
    public var label: String? {
        let percent = progress.map { " \(Int(($0 * 100).rounded()))%" } ?? ""
        return switch self {
        case .idle: nil
        case .checking: "Checking for Updates…"
        case .available: "Update Available"
        case .downloading: "Downloading…\(percent)"
        case .extracting: "Preparing…\(percent)"
        case .installing: "Installing…"
        case .upToDate: "Up to Date"
        case .failed(let failure): failure.title
        }
    }

    /// Whether this ends by itself: a moment later the pill goes away.
    public var isPassing: Bool { self == .upToDate }
}
