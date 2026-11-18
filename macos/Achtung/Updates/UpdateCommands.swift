import AchtungDomain
import SwiftUI

/// "Check for Updates…", in the app menu and the menu bar's. Where this copy can't update
/// itself it's disabled and says why underneath (ADR 0021). `AchtungApp` puts the
/// `UpdateController` in the environment of the scenes that show it.
struct CheckForUpdatesButton: View {
    @Environment(UpdateController.self) private var updates

    var body: some View {
        Button {
            updates.checkForUpdates()
        } label: {
            Text("Check for Updates…")
            if !updates.canCheck, let reason = updates.availability.reason {
                Text(reason)
            }
        }
        .disabled(!updates.canCheck)
    }
}

/// The app menu's "Check for Updates…", after About Achtung.
struct UpdateCommands: Commands {
    let updates: UpdateController

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            CheckForUpdatesButton()
                .environment(updates)
        }
    }
}

/// Settings' update rows: whether Achtung checks by itself, and which build this is.
struct UpdateSettings: View {
    @Environment(UpdateController.self) private var updates

    var body: some View {
        @Bindable var updates = updates
        Toggle("Check for updates automatically", isOn: $updates.automaticallyChecks)
            .disabled(updates.availability != .active)
        Text(
            updates.availability.reason
                ?? "Once a day. Achtung asks before it installs an update."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        Text(AppVersion.current.description)
            .font(.caption)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
    }
}
