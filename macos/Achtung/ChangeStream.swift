import AchtungAPI
import AchtungDomain
import AppKit
import Network

extension Notification.Name {
    /// Occurrences or silences changed on the server (ADR 0019); `changedServer` says which.
    /// Home and an Alertmanager's detail reload, as their counts and lists include both.
    static let alertsChanged = Notification.Name("alertsChanged")
}

/// Keeps one server's change stream open (`AchtungServer.followChanges`, ADR 0019) and says
/// what to read again: everything on `ready`, then each change, gathered for a moment so a
/// burst becomes one read. It connects again at once when the Mac wakes or the network
/// comes back or changes, as the old connection is likely gone.
@MainActor
final class ChangeStream {
    /// Changes arriving within this are read together.
    private static let gathering = Duration.milliseconds(300)

    /// Whether the stream is open and said `ready`: the poll can slow down.
    private(set) var isLive = false

    private let server: AchtungServer
    private let reread: (Set<ServerChange>) -> Void
    private var connection: Task<Void, Never>?
    private var gathered: Set<ServerChange> = []
    private var flush: Task<Void, Never>?
    private var wakeObserver: (any NSObjectProtocol)?
    private let network = NWPathMonitor()
    /// The interfaces in use, empty when offline. Nil until the network monitor's first
    /// report, which only says how things are.
    private var interfaces: [String]?
    /// When the last connection started: a wake and the network changes it brings come
    /// together, and make one new connection.
    private var connectedAt: ContinuousClock.Instant?
    /// Stopped for good: a network change or wake queued before `stop()` doesn't reconnect.
    private var stopped = false

    /// `reread` is told what to read again: every kind on `ready`.
    init(server: AchtungServer, reread: @escaping (Set<ServerChange>) -> Void) {
        self.server = server
        self.reread = reread
    }

    func start() {
        connect()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reconnect() }
        }
        network.pathUpdateHandler = { [weak self] path in
            let interfaces =
                path.status == .satisfied ? path.availableInterfaces.map(\.name) : []
            Task { @MainActor in self?.networkChanged(interfaces: interfaces) }
        }
        network.start(queue: DispatchQueue(label: "ChangeStream.network"))
    }

    func stop() {
        stopped = true
        connection?.cancel()
        flush?.cancel()
        network.cancel()
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
        isLive = false
    }

    /// Back online, or onto another network: the old connection is likely gone. Other
    /// reports, such as a connection becoming expensive, change nothing.
    private func networkChanged(interfaces: [String]) {
        defer { self.interfaces = interfaces }
        if !interfaces.isEmpty, let previous = self.interfaces, previous != interfaces {
            reconnect()
        }
    }

    /// Connects again, unless a connection started just now.
    private func reconnect() {
        if let connectedAt, ContinuousClock.now - connectedAt < .seconds(1) { return }
        connect()
    }

    /// (Re)connects now, dropping the connection there is.
    private func connect() {
        guard !stopped else { return }
        connection?.cancel()
        connectedAt = .now
        isLive = false
        connection = Task { [weak self, server] in
            await server.followChanges { self?.received($0) }
        }
    }

    private func received(_ update: ChangeStreamUpdate) {
        switch update {
        case .ready:
            isLive = true
            reread(Set(ServerChange.allCases))
        case .changed(let change):
            gather(change)
        case .down(_, let failure):
            isLive = false
            if let failure {
                print("Achtung's change stream failed, polling meanwhile: \(failure)")
            }
        }
    }

    private func gather(_ change: ServerChange) {
        gathered.insert(change)
        guard flush == nil else { return }
        flush = Task { [weak self] in
            try? await Task.sleep(for: Self.gathering)
            guard let self, !Task.isCancelled else { return }
            let changes = gathered
            gathered = []
            flush = nil
            reread(changes)
        }
    }
}
