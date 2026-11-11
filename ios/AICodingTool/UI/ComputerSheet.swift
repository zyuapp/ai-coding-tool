import SwiftUI

/// Every computer the phone is paired with: a tap switches to one, its info button opens its page, and the last row pairs another.
struct ComputersSheet: View {
    var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var path: [Page] = []
    @State private var token: String?

    enum Page: Hashable {
        case computer(URL)
        case pairing
    }

    var body: some View {
        let computers = model.connection.computers
        NavigationStack(path: $path) {
            List {
                Section {
                    ForEach(computers) { computer in
                        row(computer, twin: computers.contains { $0.id != computer.id && $0.title == computer.title }).sheetRow()
                    }
                    Button { path.append(.pairing) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "plus").font(.subheadline.weight(.semibold)).frame(width: 20)
                            Text("Pair a Computer")
                        }
                        .foregroundStyle(palette.accent)
                    }
                    .sheetRow()
                }
            }
            .sheetPage("Computers", palette: palette)
            .toolbar { SheetClose { dismiss() } }
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .computer(let origin):
                    if let computer = model.connection.computers.first(where: { $0.origin == origin }) {
                        ComputerPage(model: model, computer: computer, onSwitch: { use(computer) }, onForget: { forget(computer) })
                    }
                case .pairing:
                    GateView(model: model).navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        .presentationDetents([.medium, .large])
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
    }

    private func current(_ computer: PairedComputer) -> Bool { computer.origin == model.connection.origin }

    private func row(_ computer: PairedComputer, twin: Bool) -> some View {
        let here = current(computer)
        return HStack(spacing: 12) {
            Button { use(computer) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.accent)
                        .frame(width: 20)
                        .opacity(here ? 1 : 0)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(here ? model.state.computerName ?? computer.title : computer.title)
                            .foregroundStyle(palette.ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let detail = detail(computer, here: here, twin: twin) {
                            Text(detail).font(.footnote).foregroundStyle(palette.muted).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityAddTraits(here ? .isSelected : [])
            Button { path.append(.computer(computer.origin)) } label: {
                Image(systemName: "info.circle").font(.title3).foregroundStyle(palette.muted)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("\(computer.title) Settings")
        }
    }

    /// The live computer says how it stands and what waits; another says where it is reached only when its name is shared.
    private func detail(_ computer: PairedComputer, here: Bool, twin: Bool) -> String? {
        if here {
            if model.restarting { return "Restarting" }
            guard model.live else { return model.state.connection.label }
            return model.view.upkeepNote ?? "Connected"
        }
        return twin ? computer.address : nil
    }

    private func use(_ computer: PairedComputer) {
        model.connection.switchTo(computer)
        dismiss()
    }

    private func forget(_ computer: PairedComputer) {
        let here = current(computer)
        model.connection.forget(computer)
        if here { dismiss() } else { path.removeAll() }
    }
}

/// One computer's page. The one in use lists its software and usage; another offers to switch to it.
private struct ComputerPage: View {
    var model: PhoneModel
    var computer: PairedComputer
    var onSwitch: () -> Void
    var onForget: () -> Void
    @Environment(\.palette) private var palette
    @State private var forgetting = false

    var body: some View {
        let here = computer.origin == model.connection.origin
        List {
            if here {
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
            } else {
                Section {
                    Button(action: onSwitch) { Text("Use This Computer").foregroundStyle(palette.accent) }.sheetRow()
                }
            }
            Section {
                HStack {
                    Text("Address").foregroundStyle(palette.ink)
                    Spacer(minLength: 12)
                    Text(computer.address).font(.subheadline.monospacedDigit()).foregroundStyle(palette.muted).lineLimit(1).truncationMode(.middle)
                }
                .sheetRow()
            }
            Section {
                Button(role: .destructive) { forgetting = true } label: {
                    Text("Forget This Computer").foregroundStyle(palette.danger)
                }
                .sheetRow()
            }
        }
        .sheetPage(here ? model.state.computerName ?? computer.title : computer.title, palette: palette)
        .confirmationDialog("Forget \(computer.title)?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Forget", role: .destructive, action: onForget)
        } message: {
            Text("This phone stops connecting to it. Remove the phone from that computer's Settings › Devices too.")
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
                .buttonStyle(.borderless)
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
