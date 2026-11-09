import SwiftUI

/// Where dictation on the microphone stands.
enum TalkPhase: Equatable {
    case idle
    case starting
    case listening
    case transcribing

    /// A press shorter than this is a tap, which keeps listening hands-free.
    static let tapSeconds: TimeInterval = 0.25
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

/// Stands where the composer's settings were while dictation is listening or being written down: the
/// elapsed time, the voice as a wave flowing toward the microphone, and what letting go will do.
/// Hands-free, it leads with the button that cancels.
struct TalkStrip: View {
    var phase: TalkPhase
    var levels: [Float]
    var startedAt: Date?
    var cancelling: Bool
    var handsFree: Bool
    /// The press outlasted a tap; until then, what letting go will do isn't known yet.
    var held: Bool
    var onCancel: () -> Void

    @Environment(\.palette) private var palette
    @State private var pulse = false

    var body: some View {
        let listening = phase != .transcribing
        let freed = handsFree && listening
        let tint = cancelling ? palette.danger : listening ? palette.accent : palette.muted
        HStack(spacing: 10) {
            if freed {
                Button(action: onCancel) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(palette.inkDim)
                        .frame(width: 34, height: 34)
                        .background(palette.raised, in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.target)
                .accessibilityLabel("Cancel dictation")
                .transition(.opacity)
            }
            HStack(spacing: 6) {
                if freed {
                    Circle()
                        .fill(palette.accent)
                        .frame(width: 7, height: 7)
                        .opacity(pulse ? 0.3 : 1)
                        .animation(.easeInOut(duration: 0.6).repeatForever(), value: pulse)
                        .onAppear { pulse = true }
                        .onDisappear { pulse = false }
                }
                TimelineView(.periodic(from: .now, by: 0.5)) { context in
                    Text(elapsed(at: context.date))
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(cancelling ? palette.danger : palette.accent)
                }
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
            if !listening || cancelling || (held && !freed) {
                Text(!listening ? "Writing it down…" : cancelling ? "Let go to cancel" : "Swipe up to cancel")
                    .font(.footnote)
                    .foregroundStyle(cancelling ? palette.danger : palette.inkDim)
                    .lineLimit(1)
                    .fixedSize()
                    .transition(.opacity)
            }
        }
        .padding(.leading, freed ? -6 : 6)
        .frame(minHeight: 44)
        .animation(.touch, value: freed)
        .accessibilityElement(children: freed ? .contain : .combine)
        .accessibilityLabel(!listening ? "Writing down what you said" : freed ? "Listening hands-free" : "Listening. Let go to add the words to your message, or swipe up to cancel.")
    }

    private func elapsed(at now: Date) -> String {
        let seconds = startedAt.map { max(0, Int(now.timeIntervalSince($0))) } ?? 0
        return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
    }
}

/// The ring behind the held microphone that swells with the voice.
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

/// The mark above the held microphone that a finger slides up to, to cancel.
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
        .animation(.touch, value: armed)
        .accessibilityHidden(true)
    }
}
