// Adapted from Ghostty's macos/Sources/Features/Update/UpdatePopoverView.swift (MIT, ©
// Mitchell Hashimoto and Ghostty contributors): the pill's popover, one layout per state.

import AchtungDomain
import AppKit
import SwiftUI

/// The details behind the update pill, and what the user can do about them: install, skip
/// or postpone an update, cancel a download, or read why one failed.
struct UpdatePopover: View {
    let model: UpdateModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch model.state {
            case .idle:
                EmptyView()
            case .checking:
                progress("Checking for Updates…", value: nil)
                buttons { Button("Cancel", role: .cancel) { model.cancel() } }
            case .available(let update):
                AvailableUpdateDetails(update: update)
                buttons {
                    Button("Skip") { model.choose(.skip) }
                        .help("Don't offer this build again")
                    Button("Later") { model.choose(.later) }
                        .keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("Install and Relaunch") { model.choose(.install) }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                }
            case .downloading:
                progress("Downloading the Update", value: model.state.progress)
                buttons { Button("Cancel", role: .cancel) { model.cancel() } }
            case .extracting:
                progress("Preparing the Update", value: model.state.progress)
            case .installing:
                message(
                    "Installing the Update",
                    "Achtung quits, installs the update and opens again. If it's still here, "
                        + "something is keeping it from quitting.")
                buttons {
                    Spacer()
                    Button("Relaunch Now") { model.relaunch() }
                }
            case .upToDate:
                message("Achtung Is Up to Date", "\(AppVersion.current.description) is the newest.")
                buttons {
                    Spacer()
                    Button("OK") { model.dismiss() }
                        .keyboardShortcut(.defaultAction)
                }
            case .failed(let failure):
                FailureDetails(failure: failure)
                buttons {
                    Spacer()
                    if failure.canRetry {
                        Button("Try Again") { model.checkAgain() }
                    }
                    Button("OK") { model.dismiss() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .controlSize(.small)
        .padding(16)
        .frame(width: 320, alignment: .leading)
    }

    private func message(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A bar that fills once the progress is known.
    private func progress(_ title: String, value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            ProgressView(value: value)
                .progressViewStyle(.linear)
        }
    }

    private func buttons(@ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 8, content: content)
    }
}

extension AppVersion {
    /// "Achtung 13c8d67 (build 412)".
    var description: String { "Achtung \(version) (build \(build))" }
}

/// The update on offer: its version, age and size, and a link to what changed.
private struct AvailableUpdateDetails: View {
    let update: AvailableUpdate

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Update Available")
                .font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 3) {
                row("Version", "\(update.version) (build \(update.build))")
                row(
                    "Installed", "\(AppVersion.current.version) (build \(AppVersion.current.build))"
                )
                if let published = update.published {
                    row("Published", published.formatted(date: .abbreviated, time: .shortened))
                }
                if let size = update.size {
                    row("Size", Int64(size).formatted(.byteCount(style: .file)))
                }
            }
            .font(.callout)
            .textSelection(.enabled)
            if let changes = update.changes(since: AppVersion.current.version) {
                Link(destination: changes) {
                    Label("What Changed", systemImage: "arrow.up.right")
                }
                .font(.callout)
            }
        }
    }

    private func row(_ name: String, _ value: String) -> some View {
        GridRow {
            Text(name)
                .foregroundStyle(.secondary)
                .gridColumnAlignment(.trailing)
            Text(value)
        }
    }
}

/// Why an update didn't happen, and for a translocated app, how to fix it.
private struct FailureDetails: View {
    /// Verified in the spike (ADR 0021): without the download's quarantine mark macOS
    /// runs the app from where it is.
    private static let fix = "xattr -dr com.apple.quarantine /Applications/Achtung.app"

    let failure: UpdateFailure

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(failure.title, systemImage: failure.symbol)
                .font(.headline)
                .foregroundStyle(failure.tint)
            Text(failure.explanation)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if failure == .translocated {
                Text(
                    "Quit Achtung, then either move Achtung.app to another folder in Finder "
                        + "(and back, if you like), or clear the download mark in Terminal, "
                        + "with the app's real location:"
                )
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Self.fix)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(Self.fix, forType: .string)
                    }
                }
                Text("Then open Achtung again.")
                    .font(.callout)
            }
        }
    }
}
