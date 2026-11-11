import SwiftUI

/// The computer in use, laid open: how it stands, its software and usage, then the others to switch to, pairing, and forgetting it.
struct ComputersSheet: View {
    var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var path: [Page] = []
    @State private var token: String?
    @State private var forgetting: PairedComputer?

    enum Page: Hashable { case pairing }

    private var current: PairedComputer? { model.connection.computers.first { $0.origin == model.connection.origin } }

    var body: some View {
        let computers = model.connection.computers
        let others = computers.filter { $0.origin != model.connection.origin }
        NavigationStack(path: $path) {
            List {
                if let current {
                    Section { identity(current).sheetRow() }
                    software
                    if model.live, let usage = model.view.usage {
                        Section {
                            NavigationLink {
                                UsageList(model: model).sheetPage("Usage", palette: palette)
                            } label: {
                                HStack {
                                    Text("Usage").foregroundStyle(palette.ink)
                                    Spacer(minLength: 12)
                                    if let summary = usage.summary { Text(summary).font(.subheadline).foregroundStyle(palette.muted).lineLimit(1) }
                                }
                            }
                            .sheetRow()
                        }
                    }
                }
                if !others.isEmpty {
                    Section {
                        ForEach(others) { computer in
                            other(computer, twin: computers.contains { $0.id != computer.id && $0.title == computer.title }).sheetRow()
                        }
                    } header: {
                        SectionLabel("Switch To")
                    }
                }
                Section {
                    Button { path.append(.pairing) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "plus").font(.subheadline.weight(.semibold)).frame(width: 24)
                            Text("Pair a Computer")
                        }
                        .foregroundStyle(palette.accent)
                    }
                    .sheetRow()
                }
                if let current {
                    Section {
                        Button(role: .destructive) { forgetting = current } label: {
                            Text("Forget \(current.title)…").foregroundStyle(palette.danger).lineLimit(1).truncationMode(.middle)
                        }
                        .sheetRow()
                    }
                }
            }
            .sheetPage("Computers", palette: palette)
            .toolbar { SheetClose { dismiss() } }
            .navigationDestination(for: Page.self) { _ in
                GateView(model: model).navigationBarTitleDisplayMode(.inline)
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .sheetPresentationGround(palette)
        .onAppear {
            token = model.state.credential?.token
            model.checkForUpdates()
            model.readUsage(within: 15 * 60)
        }
        .onChange(of: model.state.credential?.token) { _, next in
            if let next, next != token { dismiss() }
        }
        .confirmationDialog(forgetting.map { "Forget \($0.title)?" } ?? "", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                guard let computer = forgetting else { return }
                let here = computer.origin == model.connection.origin
                model.connection.forget(computer)
                if here { dismiss() }
            }
        } message: {
            Text("This phone stops connecting to it. Remove the phone from that computer's Settings › Devices too.")
        }
    }

    private func identity(_ computer: PairedComputer) -> some View {
        let live = model.live && !model.restarting
        return HStack(spacing: 14) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(palette.ink)
                .frame(width: 44, height: 44)
                .background(palette.ink.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(model.state.computerName ?? computer.title)
                    .font(.headline)
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 6) {
                    if live {
                        Circle().fill(palette.success).frame(width: 7, height: 7)
                    } else if model.state.connection != .offline {
                        Spinner(size: 11)
                    }
                    Text(model.restarting ? "Restarting" : live ? "Connected" : model.state.connection.label)
                }
                .font(.footnote)
                .foregroundStyle(palette.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var software: some View {
        Section {
            if !model.live {
                Text("Connect to the computer to manage it.").foregroundStyle(palette.muted).sheetRow()
            } else if let upkeep = model.view.upkeep, !upkeep.isEmpty {
                ForEach(upkeep) { SoftwareRow(model: model, item: $0).sheetRow() }
            } else {
                Text("Checking…").foregroundStyle(palette.muted).sheetRow()
            }
        } header: {
            SectionLabel("Software")
        }
    }

    /// Another computer: a tap switches to it, and a swipe forgets it. Its address shows only when its name is shared.
    private func other(_ computer: PairedComputer, twin: Bool) -> some View {
        Button {
            model.connection.switchTo(computer)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer").font(.subheadline).foregroundStyle(palette.muted).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(computer.title).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                    if twin { Text(computer.address).font(.footnote).foregroundStyle(palette.muted).lineLimit(1) }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .accessibilityHint("Switches to this computer")
        .swipeActions {
            Button("Forget") { forgetting = computer }.tint(palette.danger)
        }
    }
}

/// The app or an engine: its version when it is current, otherwise where it stands and the one step it offers.
private struct SoftwareRow: View {
    var model: PhoneModel
    var item: MobileUpkeepItem
    @Environment(\.palette) private var palette

    /// Current and asking nothing, so the version alone says it.
    private var settled: Bool { item.state.tone == "quiet" && item.version != nil && item.action == nil }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.label).foregroundStyle(palette.ink)
                if !settled {
                    Text(item.state.text).font(.footnote).foregroundStyle(item.state.tone == "error" ? palette.danger : palette.muted)
                }
            }
            Spacer(minLength: 8)
            if let action = item.action {
                let primary = action.label == "Update"
                Button { model.send(action.command) } label: {
                    Text(action.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(primary ? palette.accent : palette.inkDim)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(primary ? palette.accent.opacity(0.14) : palette.ink.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.target)
                .accessibilityLabel("\(action.label) \(item.label)")
            } else if item.state.tone == "progress" {
                Spinner(size: 16)
            } else if settled, let version = item.version {
                Text(version).font(.subheadline.monospacedDigit()).foregroundStyle(palette.muted)
            }
        }
        .padding(.vertical, settled ? 0 : 2)
        .accessibilityElement(children: .contain)
    }
}
