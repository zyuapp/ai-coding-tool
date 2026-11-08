import SwiftUI

/// The app: the gate until the phone is paired, then the thread list with the open thread above it.
struct RootView: View {
    @Bindable var model: PhoneModel
    @Environment(\.colorScheme) private var systemScheme
    @State private var storedTheme = PhoneStorage().theme ?? .standard

    private var theme: MobileTheme {
        model.state.synced ? model.view.theme : storedTheme
    }

    var body: some View {
        let palette = Palette.resolve(theme, systemDark: systemScheme == .dark)
        content
            .environment(\.palette, palette)
            .tint(palette.accent)
            .preferredColorScheme(theme.mode == "auto" ? nil : palette.scheme)
            .onChange(of: model.view.theme) { _, next in
                guard model.state.synced else { return }
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
                .safeAreaInset(edge: .bottom) { PairedComputers(model: model) }
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
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.subheadline)
                .foregroundStyle(palette.accent)
                .accessibilityHidden(true)
            Button { open.toggle() } label: {
                Text(notice)
                    .font(.subheadline)
                    .foregroundStyle(palette.ink)
                    .lineLimit(open ? nil : 3)
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
        .padding(.vertical, 12)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(palette.lineSoft))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
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
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: model.notice)
    }

    func screenBackground(_ palette: Palette) -> some View {
        background(palette.canvas.ignoresSafeArea())
    }

    /// On iOS 26, content scrolling under the bar is cut off sharply rather than faded, so text never reads through the title.
    @ViewBuilder func hardTopEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            self
        }
    }
}

/// Which computer the phone is talking to, and the way to the others: switch, pair another, or forget this one.
struct ComputerMenu: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var pairing = false
    @State private var forgetting: PairedComputer?

    private var current: PairedComputer? { model.connection.computers.first { $0.origin == model.connection.origin } }

    var body: some View {
        Menu {
            Section("Computers") {
                ForEach(model.connection.computers) { computer in
                    Button { model.connection.switchTo(computer) } label: {
                        if computer.origin == model.connection.origin { Label(computer.title, systemImage: "checkmark") } else { Text(computer.title) }
                    }
                }
            }
            Section {
                Button { pairing = true } label: { Label("Pair a Computer…", systemImage: "plus") }
                if let current {
                    Button(role: .destructive) { forgetting = current } label: { Label("Forget \(current.title)…", systemImage: "minus.circle") }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "desktopcomputer").font(.footnote.weight(.semibold))
                Text(model.state.computerName ?? current?.title ?? "Computer").lineLimit(1)
                if model.state.connection != .live {
                    ConnectionMark(connection: model.state.connection)
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.6)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(palette.ink)
        }
        .accessibilityLabel("Computer: \(model.state.computerName ?? current?.title ?? "none"), \(model.state.connection.label)")
        .sheet(isPresented: $pairing) { PairAnotherSheet(model: model) }
        .confirmationDialog(forgetting.map { "Forget \($0.title)?" } ?? "", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                if let forgetting { model.connection.forget(forgetting) }
            }
        } message: {
            Text("This phone stops connecting to it. Remove the phone from that computer's Settings › Devices too.")
        }
    }
}

/// The pairing screen as a sheet, which closes once the new computer has let the phone in.
private struct PairAnotherSheet: View {
    var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @State private var token: String?

    var body: some View {
        NavigationStack {
            GateView(model: model)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear { token = model.state.credential?.token }
        .onChange(of: model.state.credential?.token) { _, next in
            if let next, next != token { dismiss() }
        }
    }
}

/// Under the pairing screen, the computers this phone is already paired with, to go back to one.
private struct PairedComputers: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette

    var body: some View {
        let computers = model.connection.computers
        if !computers.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Or go back to").font(.footnote.weight(.semibold)).foregroundStyle(palette.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(computers) { computer in
                            Button { model.connection.switchTo(computer) } label: {
                                Label(computer.title, systemImage: "desktopcomputer")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 8)
                                    .background(palette.surface, in: Capsule())
                                    .overlay(Capsule().strokeBorder(palette.line))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(palette.inkDim)
                        }
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.canvas)
        }
    }
}
