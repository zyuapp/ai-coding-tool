import SwiftUI

/// The distances every screen measures with.
enum Space {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    /// A screen's side margin for text.
    static let page: CGFloat = 20
    /// The side margin of a card that floats over a screen.
    static let card: CGFloat = 12
    /// The column left of a list's text, which holds a row's mark or a section's chevron.
    static let gutter: CGFloat = 18
}

/// Corner radii, smallest to largest. Every shape is continuous.
enum Radius {
    static let chip: CGFloat = 8
    static let block: CGFloat = 14
    static let row: CGFloat = 16
    static let bubble: CGFloat = 20
    static let card: CGFloat = 24
    static let field: CGFloat = 26
}

extension Animation {
    /// Layout on the move: a card arriving, a section folding, a row changing place.
    static let glide = Animation.spring(response: 0.36, dampingFraction: 0.86)
    /// A control answering a touch.
    static let touch = Animation.spring(response: 0.22, dampingFraction: 0.82)
}

extension AnyTransition {
    /// Content that arrives from below, as a new message does.
    static var rise: AnyTransition {
        .asymmetric(insertion: .opacity.combined(with: .offset(y: 10)), removal: .opacity)
    }

    /// A floating control that grows out of its place.
    static var pop: AnyTransition {
        .scale(scale: 0.8).combined(with: .opacity)
    }
}

/// A thin arc that turns while something works.
struct Spinner: View {
    var size: CGFloat = 13
    var color: Color?
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let line = max(1.5, size * 0.13)
        TimelineView(.animation(minimumInterval: reduceMotion ? 0.5 : nil)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9
            ZStack {
                Circle().stroke((color ?? palette.inkDim).opacity(0.18), lineWidth: line)
                Circle()
                    .trim(from: 0, to: 0.3)
                    .stroke(color ?? palette.inkDim, style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .rotationEffect(.degrees(turn * 360))
            }
            .padding(line / 2)
        }
        .frame(width: size, height: size)
    }
}

/// A band of light crossing the content, for words that say work is under way.
private struct Shimmer: ViewModifier {
    var highlight: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.overlay {
                TimelineView(.animation) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                    GeometryReader { box in
                        let band = max(40, box.size.width * 0.55)
                        LinearGradient(colors: [.clear, highlight, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: band)
                            .offset(x: -band + (box.size.width + band) * phase)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        }
    }
}

extension View {
    func shimmer(_ highlight: Color) -> some View { modifier(Shimmer(highlight: highlight)) }
}

extension View {
    /// The ground of a control that floats over content: Liquid Glass on iOS 26, else a raised surface.
    @ViewBuilder func floatingSurface<S: InsettableShape>(_ palette: Palette, in shape: S) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.tint(palette.surface.opacity(0.55)).interactive(), in: shape)
        } else {
            background(palette.surface, in: shape)
                .overlay(shape.strokeBorder(palette.lineSoft))
                .shadow(color: .black.opacity(palette.dark ? 0.3 : 0.06), radius: 12, y: 4)
        }
    }
}

/// A filled control that gives a little under the finger.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.touch, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressStyle {
    static var press: PressStyle { PressStyle() }
}

/// A screen's primary action: full width, in the accent, or quiet when it has nothing to act on.
struct ActionLabel: View {
    var title: String
    var symbol: String?
    var busy = false
    var prominent = true
    var enabled = true
    @Environment(\.palette) private var palette

    var body: some View {
        let lit = prominent && enabled
        HStack(spacing: 7) {
            if busy {
                Spinner(size: 15, color: lit ? palette.accentInk : palette.ink)
            } else if let symbol {
                Image(systemName: symbol).font(.subheadline.weight(.semibold))
            }
            Text(title)
        }
        .font(.body.weight(.semibold))
        .foregroundStyle(lit ? palette.accentInk : enabled ? palette.ink : palette.muted)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(lit ? palette.accent : palette.raised, in: Capsule())
        .contentShape(Capsule())
    }
}

/// A glyph on a tinted disc, which opens a card or a strip.
struct GlyphDisc: View {
    var symbol: String
    var size: CGFloat = 34
    var live = true
    @Environment(\.palette) private var palette

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(live ? palette.accent : palette.muted)
            .frame(width: size, height: size)
            .background(live ? palette.accentChip : palette.raised, in: Circle())
            .accessibilityHidden(true)
    }
}
