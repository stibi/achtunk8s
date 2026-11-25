import AchtungAPI
import AchtungDomain
import SwiftUI

/// One handover: where it is while it runs, with Cancel, and what came back once it ended.
/// The result is text from another program (ADR 0022): shown as text, marked as the
/// handler's, with nothing loaded from it.
struct HandoverCard: View {
    let handover: Handover

    @Environment(\.handovers) private var actions
    @Environment(\.openURL) private var openURL
    @State private var isCancelling = false
    @State private var problem: ServerError?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label(handover.title, systemImage: symbol)
                    .font(.headline)
                    .foregroundStyle(tint)
                Spacer()
                if handover.isActive {
                    ProgressView()
                        .controlSize(.small)
                    Button("Cancel", action: cancel)
                        .disabled(isCancelling)
                        .help(
                            "Stop this handover. \(handover.handlerName) is told to stop working.")
                }
            }
            content
            if let problem {
                Label(problem.detail, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Text(footer)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .textSelection(.enabled)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var content: some View {
        if case .succeeded(_, _, let result) = handover.state {
            Text(result.summary)
                .font(.title3)
            if !result.body.isEmpty {
                Text(handoverText(result.body))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !result.links.isEmpty {
                FlowLayout(spacing: 8) {
                    ForEach(result.links, id: \.self) { link in
                        Button {
                            openURL(link.url)
                        } label: {
                            // With where it goes: the title is the handler's word for it.
                            Label(titled(link), systemImage: "link")
                        }
                        .buttonStyle(.bordered)
                        .help(link.url.absoluteString)
                    }
                }
            }
        } else {
            Text(handover.statusLine)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // What the handler said on the way, when it said more than the line above.
            if handover.progress.count > 1 {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(handover.progress, id: \.self) { line in
                        let time = line.reportedAt.formatted(date: .omitted, time: .standard)
                        // Verbatim: a handler's line is text, never Markdown.
                        Text(verbatim: "\(time)  \(line.message)")
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.tertiary)
            }
        }
    }

    /// A link's title with where it goes: the title is the handler's word for it. A string,
    /// so it is shown as it is and not read as Markdown.
    private func titled(_ link: Handover.Link) -> String {
        "\(link.title) (\(link.url.host() ?? "?"))"
    }

    private var symbol: String {
        switch handover.state {
        case .requested, .running: "sparkles"
        case .succeeded: "checkmark.circle"
        case .failed, .timedOut, .expired: "exclamationmark.circle"
        case .cancelled: "xmark.circle"
        }
    }

    private var tint: Color {
        switch handover.state {
        case .failed, .timedOut, .expired: .orange
        default: .primary
        }
    }

    /// Who did it and when: "herdr agent 0.1.0 · 14:05–14:12".
    private var footer: String {
        let time = { (date: Date) in date.formatted(date: .omitted, time: .shortened) }
        let started = handover.claimedAt ?? handover.requestedAt
        let day = started.formatted(date: .abbreviated, time: .omitted)
        let span =
            handover.finishedAt.map { "\(time(started))–\(time($0))" } ?? "since \(time(started))"
        return "By \(handover.handlerName) \(handover.handlerVersion) · \(day), \(span)"
    }

    private func cancel() {
        isCancelling = true
        problem = nil
        Task {
            problem = await actions.cancel(handover)
            isCancelling = false
        }
    }
}

/// A handler's Markdown as text to read. Inline styles only; an image is its alt text and
/// nothing is fetched. A link stays one only when it is http or https, and shows where it
/// goes when its text doesn't say: another program wrote this (ADR 0022).
func handoverText(_ markdown: String) -> AttributedString {
    let parsed =
        (try? AttributedString(
            markdown: markdown,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        ?? AttributedString(markdown)
    var shown = AttributedString()
    var pending: (link: URL, text: String)?
    /// After the last run of a link whose text isn't its target: the target, spelled out.
    func closeLink() {
        if let link = pending?.link, pending?.text != link.absoluteString {
            var target = AttributedString(" (\(link.absoluteString))")
            target.link = link
            shown.append(target)
        }
        pending = nil
    }
    for run in parsed.runs {
        var piece = AttributedString(parsed[run.range])
        piece.imageURL = nil
        let web = run.link.flatMap {
            ["http", "https"].contains($0.scheme?.lowercased()) ? $0 : nil
        }
        if pending?.link != web {
            closeLink()
        }
        piece.link = web
        if let web {
            pending = (web, (pending?.text ?? "") + String(piece.characters))
        }
        shown.append(piece)
    }
    closeLink()
    return shown
}
