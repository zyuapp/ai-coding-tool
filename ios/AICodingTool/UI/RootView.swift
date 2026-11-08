import SwiftUI

/// The app: the gate until the phone is paired, then the thread list with the open thread above it.
struct RootView: View {
    @Bindable var model: PhoneModel
    @Environment(\.colorScheme) private var systemScheme
    @State private var storedTheme = PhoneStorage().theme ?? .standard

    private var theme: MobileTheme {
        model.state.build != nil ? model.view.theme : storedTheme
    }

    var body: some View {
        let palette = Palette.resolve(theme, systemDark: systemScheme == .dark)
        content
            .environment(\.palette, palette)
            .tint(palette.accent)
            .preferredColorScheme(theme.mode == "auto" ? nil : palette.scheme)
            .onChange(of: model.view.theme) { _, next in
                guard model.state.build != nil else { return }
                storedTheme = next
                PhoneStorage().theme = next
            }
            .onChange(of: model.current) { _, _ in
                model.reconsiderOpening()
                model.threadMoved()
            }
            .onChange(of: model.live) { _, _ in model.reconsiderOpening() }
    }

    @ViewBuilder private var content: some View {
        if model.state.entry == .blocked, model.state.credential == nil {
            GateView(model: model)
        } else {
            NavigationStack(path: $model.path) {
                ThreadListScreen(model: model)
                    .navigationDestination(for: Route.self) { route in
                        switch route {
                        case .thread: ThreadScreen(model: model)
                        case .changes: ChangesScreen(model: model)
                        }
                    }
            }
            .onChange(of: model.path) { _, _ in model.pathChanged() }
        }
    }
}

/// Quiet until it matters: a live line says nothing, a dead one shows a struck cloud, and one on its way a turning ring.
struct ConnectionMark: View {
    var connection: ConnectionState
    @Environment(\.palette) private var palette

    var body: some View {
        if connection != .live {
            HStack(spacing: 4) {
                if connection == .offline {
                    Image(systemName: "icloud.slash").font(.caption.weight(.semibold))
                } else {
                    ProgressView().controlSize(.mini)
                }
                Text(connection.label).font(.caption.weight(.medium))
            }
            .foregroundStyle(palette.muted)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(connection.label)
        }
    }
}

/// A notice under the bar: the words open to their full length, and only the cross puts it away.
struct NoticeBanner: View {
    var notice: String
    var onDismiss: () -> Void
    @State private var open = false
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button { open.toggle() } label: {
                Text(notice)
                    .font(.subheadline)
                    .foregroundStyle(palette.inkDim)
                    .lineLimit(open ? nil : 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Shows less" : "Shows the whole notice")
            Button(action: onDismiss) {
                Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(palette.muted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(palette.sunken)
        .overlay(alignment: .bottom) { palette.line.frame(height: 0.5) }
    }
}

@MainActor
extension View {
    /// The notice strip under the navigation bar, on every screen.
    func notice(_ model: PhoneModel) -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            if let notice = model.notice {
                NoticeBanner(notice: notice) { model.connection.dismissNotice() }
                    .id(notice)
            }
        }
    }

    func screenBackground(_ palette: Palette) -> some View {
        background(palette.canvas.ignoresSafeArea())
            .toolbarBackground(palette.sunken, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}
