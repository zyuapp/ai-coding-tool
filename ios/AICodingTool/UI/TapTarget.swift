import SwiftUI

/// A plain button that answers anywhere inside its label's frame, including clear padding, frames and
/// Liquid Glass, which a plain button otherwise skips because it hit-tests only drawn pixels.
/// Use it in place of `.plain`.
struct TargetButtonStyle: PrimitiveButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button(role: configuration.role, action: configuration.trigger) {
            configuration.label.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

extension PrimitiveButtonStyle where Self == TargetButtonStyle {
    static var target: TargetButtonStyle { TargetButtonStyle() }
}

extension View {
    /// Answers taps across at least 44×44 points centred on the view, without changing its layout.
    func minimumTapTarget() -> some View {
        background {
            Color.clear
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
    }
}
