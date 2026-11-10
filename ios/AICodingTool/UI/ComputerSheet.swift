import SwiftUI

/// One computer's own page: the software it runs and the step each offers, its plan usage, and the way to forget it.
struct ComputerSheet: View {
    var model: PhoneModel
    var computer: PairedComputer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var forgetting = false

    var body: some View {
        SheetFrame(title: model.state.computerName ?? computer.title) {
            List {
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
                Section {
                    Button(role: .destructive) { forgetting = true } label: {
                        Text("Forget This Computer").frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .foregroundStyle(palette.danger)
                    .sheetRow()
                }
            }
        } actions: {
            SheetClose { dismiss() }
        }
        .presentationDetents([.large])
        .onAppear {
            model.checkForUpdates()
            model.readUsage(within: 15 * 60)
        }
        .confirmationDialog("Forget \(computer.title)?", isPresented: $forgetting, titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                dismiss()
                model.connection.forget(computer)
            }
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
