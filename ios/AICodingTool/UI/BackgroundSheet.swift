import SwiftUI

/// What the thread keeps running beside its conversation, above it while anything is live.
struct BackgroundStrip: View {
    var items: [MobileBackgroundItem]
    var onOpen: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .frame(width: 30, height: 30)
                    .background(palette.accentChip, in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text("Running in background").font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    Text(BackgroundWork.summary(items)).font(.footnote).foregroundStyle(palette.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                RunningMark()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.quiet)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .accessibilityHint("Shows its subagents and processes")
    }
}

/// The thread's workflows, processes and subagents, as the desktop's session panel lists them. Each live one can be stopped.
struct BackgroundSheet: View {
    var items: [MobileBackgroundItem]
    var onStop: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var stopping: MobileBackgroundItem?

    var body: some View {
        let live = items.filter(\.live)
        let done = items.filter { !$0.live }
        SheetFrame(title: "Background") {
            List {
                if items.isEmpty {
                    Text("Nothing running.").foregroundStyle(palette.muted).listRowBackground(Color.clear)
                }
                if !live.isEmpty {
                    Section { ForEach(live) { row($0) } } header: { SectionLabel("Running") }
                }
                if !done.isEmpty {
                    Section { ForEach(done) { row($0) } } header: { SectionLabel("Finished") }
                }
            }
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
        .confirmationDialog(stopping.map { "Stop \($0.title)?" } ?? "", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }), titleVisibility: .visible, presenting: stopping) { item in
            Button("Stop", role: .destructive) { onStop(item.id) }
        } message: { item in
            Text(item.kind == "agent" ? "The thread keeps running." : "The thread keeps running, without this \(item.kind == "workflow" ? "workflow" : "process").")
        }
    }

    private func row(_ item: MobileBackgroundItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: BackgroundWork.symbol(item.kind))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(item.live ? palette.accent : palette.muted)
                .frame(width: 28, height: 28)
                .background(item.live ? palette.accentChip : palette.surface, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).foregroundStyle(palette.ink).lineLimit(2)
                Text(item.detail).font(.footnote).foregroundStyle(item.status == "failed" ? palette.danger : palette.muted).lineLimit(2)
            }
            Spacer(minLength: 0)
            trailing(item)
        }
        .listRowBackground(palette.raised)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func trailing(_ item: MobileBackgroundItem) -> some View {
        if item.stopping == true {
            ProgressView().controlSize(.small).tint(palette.muted).accessibilityLabel("Stopping")
        } else if item.stoppable {
            Button { stopping = item } label: {
                Image(systemName: "stop.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(palette.danger)
                    .frame(width: 32, height: 32)
                    .background(palette.dangerSurface, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop \(item.title)")
        } else {
            switch item.status {
            case "completed": Image(systemName: "checkmark.circle.fill").foregroundStyle(palette.success).accessibilityLabel("Completed")
            case "failed": Image(systemName: "xmark.circle.fill").foregroundStyle(palette.danger).accessibilityLabel("Failed")
            case "stopped": Image(systemName: "stop.circle").foregroundStyle(palette.muted).accessibilityLabel("Stopped")
            case "idle": Image(systemName: "pause.circle").foregroundStyle(palette.muted).accessibilityLabel("Idle")
            default: RunningMark()
            }
        }
    }
}
