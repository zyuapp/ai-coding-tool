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

/// How loud a reading is once room noise is taken off: silence is 0, and quiet speech still rises.
func talkLoudness(_ level: Float) -> CGFloat {
    CGFloat(pow(max(0, min(1, (level - 0.15) / 0.85)), 0.75))
}

/// A silent bar is a dot; the loudest fills the strip's height.
func talkBarHeight(_ level: Float, tallest: CGFloat) -> CGFloat {
    3 + talkLoudness(level) * (tallest - 3)
}

/// Stands where the composer's settings were while a hold is listening or being written down: the
/// elapsed time, the voice as a wave flowing toward Send, and what letting go will do.
struct TalkStrip: View {
    var phase: TalkPhase
    var levels: [Float]
    var startedAt: Date?
    var cancelling: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        let listening = phase != .transcribing
        let tint = cancelling ? palette.danger : listening ? palette.accent : palette.muted
        HStack(spacing: 12) {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                Text(elapsed(at: context.date))
                    .font(.footnote.weight(.semibold).monospacedDigit())
                    .foregroundStyle(cancelling ? palette.danger : palette.accent)
            }
            .opacity(listening ? 1 : 0)
            HStack(spacing: 3) {
                ForEach(levels.indices, id: \.self) { index in
                    Capsule()
                        .fill(cancelling ? palette.danger.opacity(0.45) : tint)
                        .frame(width: 3, height: listening ? talkBarHeight(levels[index], tallest: 24) : 3)
                        .animation(.linear(duration: 0.09), value: levels[index])
                        .animation(.easeOut(duration: 0.25).delay(Double(index) * 0.006), value: listening)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, maxHeight: 26, alignment: .trailing)
            .clipped()
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.35)], startPoint: .leading, endPoint: .trailing))
            .accessibilityHidden(true)
            Text(!listening ? "Writing it down…" : cancelling ? "Let go to cancel" : "Swipe up to cancel")
                .font(.footnote)
                .foregroundStyle(cancelling ? palette.danger : palette.inkDim)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.leading, 6)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(listening ? "Listening. Let go to send, or swipe up to cancel." : "Writing down what you said")
    }

    private func elapsed(at now: Date) -> String {
        let seconds = startedAt.map { max(0, Int(now.timeIntervalSince($0))) } ?? 0
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}

/// The ring behind a held Send that swells with the voice.
struct TalkHalo: View {
    var level: Float

    @Environment(\.palette) private var palette

    var body: some View {
        let lifted = talkLoudness(level)
        ZStack {
            Circle().fill(palette.accent.opacity(0.22)).scaleEffect(0.9 + lifted * 0.5)
            Circle().strokeBorder(palette.accent.opacity(0.2 + lifted * 0.5), lineWidth: 1).scaleEffect(1.05 + lifted * 0.4)
        }
        .frame(width: 44, height: 44)
        .animation(.linear(duration: 0.09), value: level)
        .accessibilityHidden(true)
    }
}

/// The mark above a held Send that a finger slides up to, to cancel.
struct TalkCancelTarget: View {
    var armed: Bool

    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "xmark")
                .font(.footnote.weight(.bold))
                .foregroundStyle(armed ? palette.accentInk : palette.inkDim)
                .frame(width: 34, height: 34)
                .background(armed ? palette.danger : palette.raised, in: Circle())
                .scaleEffect(armed ? 1.2 : 1)
            Image(systemName: "chevron.compact.up")
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.muted)
                .opacity(armed ? 0 : 1)
        }
        .animation(.snappy(duration: 0.18), value: armed)
        .accessibilityHidden(true)
    }
}
