import SwiftUI

/// Where a window starts to warn, as the desktop's `NEAR_LIMIT_SHARE`.
let nearLimitShare = 80

/// How full the fullest plan window is, drawn inside the settings chip.
struct UsageRing: View {
    var share: Int
    var size: CGFloat = 14
    @Environment(\.palette) private var palette

    var body: some View {
        let line = size * 0.17
        ZStack {
            Circle().stroke(palette.lineStrong, lineWidth: line)
            Circle()
                .trim(from: 0, to: CGFloat(min(max(share, 0), 100)) / 100)
                .stroke(share >= nearLimitShare ? palette.accent : palette.inkDim, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .padding(line / 2)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct UsageBar: View {
    var share: Int
    @Environment(\.palette) private var palette

    var body: some View {
        GeometryReader { box in
            Capsule().fill(palette.line)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(share >= nearLimitShare ? palette.accent : palette.inkDim)
                        .frame(width: box.size.width * CGFloat(min(max(share, 0), 100)) / 100)
                }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

extension MobileComposerUsage {
    /// The meter's parts as the desktop composer reads them.
    var summary: String {
        meter.isEmpty ? "\(share)% used" : meter.map { "\($0.span) \($0.share)%" }.joined(separator: " · ")
    }

    /// The gauge a menu row can show, since a menu draws only symbols.
    var symbol: String {
        switch share {
        case ..<34: "gauge.with.dots.needle.0percent"
        case ..<67: "gauge.with.dots.needle.33percent"
        case ..<100: "gauge.with.dots.needle.67percent"
        default: "gauge.with.dots.needle.100percent"
        }
    }
}

extension MobileUsage {
    /// Each engine's fullest window, for a line naming them all.
    var summary: String? {
        let parts = engines.compactMap { engine in engine.windows.compactMap(\.share).max().map { "\(engine.label) \($0)%" } }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The line over the composer once a window its model spends runs low, until the user puts it away.
struct UsageWarningRow: View {
    var warning: MobileComposerUsage.Warning
    var onOpen: (() -> Void)?
    var onDismiss: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Button { onOpen?() } label: {
                HStack(spacing: 10) {
                    UsageBar(share: warning.share).frame(width: 36)
                    Text(warning.share >= 100 ? "Limit reached" : "\(warning.share)% used")
                        .fontWeight(.semibold)
                        .foregroundStyle(palette.accent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(warning.window).foregroundStyle(palette.inkDim)
                        if let reset = Format.usageReset(warning.resetsAt, now: Date()) {
                            Text(reset).font(.caption).foregroundStyle(palette.muted)
                        }
                    }
                    .lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onOpen == nil)
            .accessibilityElement(children: .combine)
            .accessibilityHint(onOpen == nil ? "" : "Opens usage")
            Spacer(minLength: 0)
            Button(action: onDismiss) { Image(systemName: "xmark").font(.caption.weight(.bold)) }
                .buttonStyle(.plain)
                .foregroundStyle(palette.muted)
                .frame(width: 44, height: 32)
                .contentShape(Rectangle())
                .accessibilityLabel("Hide usage warning until reset")
        }
        .font(.footnote)
        .padding(.leading, 16)
        .padding(.bottom, 4)
    }
}

/// Every engine's plan limits on the computer, with the windows the open thread spends marked.
struct UsageSheet: View {
    var model: PhoneModel
    /// The windows the open thread's model spends; empty when opened from outside a thread.
    var spends: Set<String> = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        let engines = model.view.usage?.engines ?? []
        SheetFrame(title: "Usage") {
            List {
                if engines.isEmpty {
                    Text(model.live ? "No plan limits reported yet." : "Connect to the computer to see its limits.")
                        .foregroundStyle(palette.muted)
                        .listRowBackground(Color.clear)
                }
                ForEach(engines) { engine in
                    Section {
                        if let message = engine.message {
                            Text(message).foregroundStyle(palette.muted).sheetRow()
                        }
                        ForEach(engine.windows) { window in
                            row(window, spent: spends.contains(window.id)).sheetRow()
                        }
                    } header: {
                        HStack {
                            SectionLabel(engine.label)
                            Spacer()
                            if let plan = engine.plan { Text(plan).font(.footnote).foregroundStyle(palette.muted).textCase(nil) }
                        }
                    }
                }
            }
            .refreshable { model.readUsage(within: 0) }
        } actions: {
            SheetClose { dismiss() }
        }
        .presentationDetents([.medium, .large])
        .onAppear { model.readUsage(within: 60) }
    }

    private func row(_ window: MobileUsageWindow, spent: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(window.label).foregroundStyle(palette.ink)
                if spent {
                    Text("This thread")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(palette.active, in: Capsule())
                }
                Spacer(minLength: 8)
                Text(window.share.map { "\($0)%" } ?? "Not reported")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle((window.share ?? 0) >= nearLimitShare ? palette.accent : palette.inkDim)
            }
            if let share = window.share { UsageBar(share: share) }
            if let reset = Format.usageReset(window.resetsAt, now: Date()) {
                Text(reset).font(.caption).foregroundStyle(palette.muted)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
