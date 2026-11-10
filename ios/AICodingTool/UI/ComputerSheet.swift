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
                        Text("Forget This Computer").frame(maxWidth: .infinity)
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

/// The app or an engine: its version, where it stands, and the one step it offers.
private struct SoftwareRow: View {
    var model: PhoneModel
    var item: MobileUpkeepItem
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.label).foregroundStyle(palette.ink)
                    if let version = item.version {
                        Text(version).font(.footnote.monospacedDigit()).foregroundStyle(palette.muted)
                    }
                }
                Text(item.state.text).font(.footnote).foregroundStyle(tone)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if let action = item.action {
                if action.label == "Update" {
                    Button(action.label) { model.send(action.command) }
                        .buttonStyle(.borderedProminent)
                        .tint(palette.accent)
                        .foregroundStyle(palette.accentInk)
                        .controlSize(.small)
                        .accessibilityLabel("Update \(item.label)")
                } else {
                    Button(action.label) { model.send(action.command) }
                        .buttonStyle(.bordered)
                        .tint(palette.inkDim)
                        .controlSize(.small)
                        .accessibilityLabel("\(action.label), \(item.label)")
                }
            } else if item.state.tone == "progress" {
                Spinner(size: 16)
            }
        }
        .padding(.vertical, 4)
    }

    private var tone: Color {
        switch item.state.tone {
        case "error": palette.danger
        case "offer", "progress": palette.inkDim
        default: palette.muted
        }
    }
}
