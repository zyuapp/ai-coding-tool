import SwiftUI

/// Where a hold on Send stands. A press becomes a hold after `TalkPhase.holdDelay`; before that it is a tap.
enum TalkPhase: Equatable {
    case idle
    case pressing
    case starting
    case listening
    case transcribing

    static let holdDelay: Duration = .milliseconds(250)
    /// How far up a held finger travels before letting go cancels instead of sending.
    static let cancelDistance: CGFloat = 60

    var active: Bool { self == .starting || self == .listening || self == .transcribing }
}

/// Stands where the composer's settings were while a hold is listening or being written down.
struct TalkStrip: View {
    var phase: TalkPhase
    var levels: [Float]
    var cancelling: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        let listening = phase != .transcribing
        HStack(spacing: 10) {
            Circle()
                .fill(listening && !cancelling ? palette.accent : palette.muted)
                .frame(width: 8, height: 8)
                .phaseAnimator([1.0, 0.35]) { dot, opacity in dot.opacity(listening && !cancelling ? opacity : 1) } animation: { _ in .easeInOut(duration: 0.6) }
            HStack(spacing: 3) {
                ForEach(levels.indices, id: \.self) { index in
                    Capsule()
                        .fill(listening && !cancelling ? palette.accent : palette.muted)
                        .frame(width: 3, height: 22)
                        .scaleEffect(y: listening ? CGFloat(max(0.08, levels[index])) : 0.3)
                        .animation(.linear(duration: 0.09), value: levels[index])
                }
            }
            .frame(height: 22)
            .clipped()
            .accessibilityHidden(true)
            Text(!listening ? "Writing it down…" : cancelling ? "Let go to cancel" : "Swipe up to cancel")
                .font(.footnote)
                .foregroundStyle(cancelling ? palette.ink : palette.muted)
                .lineLimit(1)
                .fixedSize()
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(listening ? "Listening. Let go to send, or swipe up to cancel." : "Writing down what you said")
    }
}

/// The mark above a held Send that a finger slides up to, to cancel.
struct TalkCancelTarget: View {
    var armed: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: "xmark")
                .font(.footnote.weight(.bold))
                .foregroundStyle(armed ? palette.accentInk : palette.inkDim)
                .frame(width: 34, height: 34)
                .background(armed ? palette.accent : palette.raised, in: Circle())
                .scaleEffect(armed ? 1.15 : 1)
            Image(systemName: "chevron.up")
                .font(.caption2.weight(.bold))
                .foregroundStyle(palette.muted)
                .opacity(armed ? 0 : 1)
        }
        .animation(.snappy(duration: 0.15), value: armed)
        .accessibilityHidden(true)
    }
}
