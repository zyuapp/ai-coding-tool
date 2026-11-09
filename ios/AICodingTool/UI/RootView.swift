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
            .tint(palette.ink)
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
            .onChange(of: model.state.outbox.count) { _, _ in model.settleEdit() }
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
                        case .archived: ArchivedScreen(model: model)
                        }
                    }
            }
            .onChange(of: model.path) { _, _ in model.pathChanged() }
        }
    }
}

/// The bar's title and second line before iOS 26, which has no subtitle of its own. The system still draws a title menu's chevron beside it.
struct LegacyBarTitle: ToolbarContent {
    var title: String
    var subtitle: String?
    @Environment(\.palette) private var palette

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(title).font(.headline).foregroundStyle(palette.ink).lineLimit(1)
                if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(palette.muted).lineLimit(1) }
            }
            // The bar centres the title and does not shorten it, so it is kept clear of a back button and one trailing button.
            .frame(maxWidth: 200)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
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
                    Spinner(size: 11)
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
        HStack(alignment: .firstTextBaseline, spacing: 10) {
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
            .buttonStyle(.target)
            .accessibilityHint(open ? "Shows less" : "Shows the whole notice")
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.muted)
                    .minimumTapTarget()
            }
            .buttonStyle(.target)
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
        .animation(.glide, value: model.notice)
    }

    /// The bar's second line under the title, on iOS 26 where the system draws one; earlier, `LegacyBarTitle` draws it.
    @ViewBuilder func barSubtitle(_ text: String?) -> some View {
        if #available(iOS 26, *), let text, !text.isEmpty {
            navigationSubtitle(text)
        } else {
            self
        }
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
    @State private var panel: Panel?
    @State private var forgetting: PairedComputer?

    private enum Panel: String, Identifiable {
        case pairing, usage
        var id: String { rawValue }
    }

    private var current: PairedComputer? { model.connection.computers.first { $0.origin == model.connection.origin } }

    var body: some View {
        Menu {
            Section("Computers") {
                let computers = model.connection.computers
                ForEach(computers) { computer in
                    /// A toggle puts the checkmark in the menu's own gutter, so every name starts at one edge.
                    Toggle(isOn: Binding(get: { computer.origin == model.connection.origin }, set: { _ in model.connection.switchTo(computer) })) {
                        Text(computer.title)
                        /// Two computers of one name are told apart by where each is reached.
                        if computers.filter({ $0.title == computer.title }).count > 1 { Text(computer.address) }
                    }
                }
            }
            if model.live, let upkeep = model.view.upkeep {
                Section("Updates") { UpkeepRows(model: model, items: model.view.pendingUpkeep, all: upkeep) }
            }
            if model.live, let usage = model.view.usage {
                Section {
                    Button { panel = .usage } label: {
                        Label("Usage", systemImage: "gauge.with.dots.needle.33percent")
                        if let summary = usage.summary { Text(summary) }
                    }
                }
            }
            Section {
                Button { panel = .pairing } label: { Label("Pair a Computer…", systemImage: "plus") }
                if let current {
                    Button(role: .destructive) { forgetting = current } label: { Label("Forget \(current.title)…", systemImage: "minus.circle") }
                }
            }
        } label: {
            if #available(iOS 26, *) {
                HStack(spacing: 6) {
                    Image(systemName: "desktopcomputer")
                        .foregroundStyle(palette.ink)
                        .overlay(alignment: .topTrailing) {
                            if model.view.updateOffered, model.live {
                                Circle().fill(palette.accent).frame(width: 7, height: 7).offset(x: 3, y: -2).accessibilityHidden(true)
                            }
                        }
                    if model.restarting {
                        Spinner(size: 11)
                    } else {
                        ConnectionMark(connection: model.state.connection)
                    }
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "desktopcomputer").font(.footnote.weight(.semibold))
                    Text(model.state.computerName ?? current?.title ?? "Computer").lineLimit(1)
                    if model.restarting {
                        Spinner(size: 11)
                    } else if model.state.connection != .live {
                        ConnectionMark(connection: model.state.connection)
                    } else if model.view.updateOffered {
                        Circle().fill(palette.accent).frame(width: 7, height: 7).accessibilityHidden(true)
                    }
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.6)
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.ink)
            }
        }
        .accessibilityLabel("Computer: \(model.state.computerName ?? current?.title ?? "none"), \(model.restarting ? "Restarting" : model.state.connection.label)\(model.view.updateOffered ? ", update available" : "")")
        .simultaneousGesture(TapGesture().onEnded {
            model.checkForUpdates()
            model.readUsage(within: 15 * 60)
        })
        .onChange(of: model.live, initial: true) { _, live in
            if live {
                model.checkForUpdates()
                model.readUsage(within: 15 * 60)
            }
        }
        .sheet(item: $panel) { panel in
            switch panel {
            case .pairing: PairAnotherSheet(model: model)
            case .usage: UsageSheet(model: model)
            }
        }
        .confirmationDialog(forgetting.map { "Forget \($0.title)?" } ?? "", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                if let forgetting { model.connection.forget(forgetting) }
            }
        } message: {
            Text("This phone stops connecting to it. Remove the phone from that computer's Settings › Devices too.")
        }
    }
}

/// The computer's app and engines that want the user, each a step when there is one; "Up to date" when none do.
private struct UpkeepRows: View {
    var model: PhoneModel
    var items: [MobileUpkeepItem]
    var all: [MobileUpkeepItem]

    var body: some View {
        if items.isEmpty {
            Button {} label: {
                Text("Up to Date")
                if let app = all.first(where: { $0.key == "app" }), let version = app.version { Text("\(app.label) \(version)") }
            }
            .disabled(true)
        }
        ForEach(items) { item in
            if let action = item.action {
                Button { model.send(action.command) } label: {
                    if action.label == "Update" {
                        Text("Update \(item.label)")
                        Text(item.state.text)
                        Image(systemName: "arrow.down.circle")
                    } else {
                        Text(action.label)
                        Text("\(item.label) · \(item.state.text)")
                        Image(systemName: action.label == "Cancel" ? "xmark.circle" : "arrow.clockwise")
                    }
                }
            } else {
                Button {} label: { Text(item.label); Text(item.state.text) }.disabled(true)
            }
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
                            .buttonStyle(.target)
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
