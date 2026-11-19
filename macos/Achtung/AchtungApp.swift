import AppKit
import SwiftUI

@main
struct AchtungApp: App {
    static let mainWindowID = "main"

    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @AppStorage(ServerSetting.key) private var serverAddress = ServerSetting.defaultAddress
    /// The connection to the server, with or without a window (ADR 0013).
    @State private var app: AppModel
    /// In-app updates (ADR 0021).
    @State private var updates: UpdateController

    init() {
        let app = AppModel()
        app.connect(
            to: ServerSetting.url(
                from: UserDefaults.standard.string(forKey: ServerSetting.key)
                    ?? ServerSetting.defaultAddress))
        _app = State(initialValue: app)
        let updates = UpdateController()
        updates.start { [weak app] in app?.showWindow() }
        _updates = State(initialValue: updates)
    }

    var body: some Scene {
        // One window: notifications and the menu bar bring it back rather than opening more.
        Window("Achtung", id: Self.mainWindowID) {
            Group {
                if let inbox = app.inbox {
                    // A new address starts a fresh inbox for that server.
                    InboxView(model: inbox) { app.viewing($0, on: inbox.baseURL) }
                        .id(inbox.baseURL)
                } else {
                    ContentUnavailableView {
                        Label("Invalid server address", systemImage: "link.badge.plus")
                    } description: {
                        Text(serverAddress)
                    } actions: {
                        SettingsLink {
                            Text("Change Server…")
                        }
                    }
                }
            }
            .frame(minWidth: 900, minHeight: 500)
            .modifier(UpdateToolbar(model: updates.model))
            .shortcutsHelp()
        }
        .onChange(of: serverAddress) {
            app.connect(to: ServerSetting.url(from: serverAddress))
        }
        .commands {
            UpdateCommands(updates: updates)
            ShortcutsHelpCommands()
        }
        Settings {
            SettingsView(app: app)
                .environment(updates)
        }
        MenuBarExtra {
            MenuBarMenu(app: app)
                .environment(updates)
        } label: {
            MenuBarLabel(app: app)
        }
    }
}

/// Closing the last window leaves Achtung running in the menu bar, refreshing and
/// notifying (ADR 0013).
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
