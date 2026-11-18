// Adapted from Ghostty's macos/Sources/Features/Update/UpdatePill.swift and UpdateBadge.swift
// (MIT, © Mitchell Hashimoto and Ghostty contributors): a pill in the window's toolbar with
// the update's state, and a ring for its progress.

import AchtungDomain
import SwiftUI

/// Puts the update pill in the window's toolbar while there is something to say about an
/// update, and nothing otherwise (ADR 0021).
struct UpdateToolbar: ViewModifier {
    let model: UpdateModel

    func body(content: Content) -> some View {
        content.toolbar {
            if model.state != .idle {
                ToolbarItem(placement: .primaryAction) {
                    UpdatePill(model: model)
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
    }
}

/// Where an update stands, in a few words; clicking it opens the details (`UpdatePopover`).
private struct UpdatePill: View {
    @Bindable var model: UpdateModel

    var body: some View {
        if let label = model.state.label {
            Button {
                model.showsDetails.toggle()
            } label: {
                HStack(spacing: 5) {
                    UpdateBadge(state: model.state)
                        .frame(width: 13, height: 13)
                    Text(label)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                }
                .font(.callout.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .foregroundStyle(foreground)
                .background(background, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help(label)
            .accessibilityLabel(label)
            .popover(isPresented: $model.showsDetails, arrowEdge: .bottom) {
                UpdatePopover(model: model)
            }
        }
    }

    private var foreground: Color {
        switch model.state {
        case .available: .white
        case .failed(let failure): failure.tint
        default: .primary
        }
    }

    private var background: Color {
        switch model.state {
        case .available: .accentColor
        case .failed(let failure): failure.tint.opacity(0.18)
        default: Color.primary.opacity(0.08)
        }
    }
}

extension UpdateFailure {
    /// Red for a failed signature check, which is never a hiccup; orange for the rest.
    var tint: Color {
        if case .improperlySigned = self { .red } else { .orange }
    }

    var symbol: String {
        if case .improperlySigned = self {
            "exclamationmark.shield.fill"
        } else {
            "exclamationmark.triangle.fill"
        }
    }
}

/// The pill's icon: a ring while a download or its unpacking has progress to show.
private struct UpdateBadge: View {
    let state: UpdateState

    var body: some View {
        if let progress = state.progress {
            ZStack {
                Circle()
                    .stroke(.primary.opacity(0.2), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(.primary, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .padding(1)
        } else {
            Image(systemName: symbol)
        }
    }

    private var symbol: String {
        switch state {
        case .idle, .checking: "arrow.triangle.2.circlepath"
        case .available: "arrow.down.circle.fill"
        case .downloading: "arrow.down.circle"
        case .extracting: "shippingbox"
        case .installing: "arrow.clockwise.circle"
        case .upToDate: "checkmark.circle"
        case .failed(let failure): failure.symbol
        }
    }
}
