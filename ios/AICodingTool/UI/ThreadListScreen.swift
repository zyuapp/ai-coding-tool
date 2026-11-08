import SwiftUI

/// The activity list, ranked the way the desktop's sidebar ranks it: what wants the user first.
struct ThreadListScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var picking = false
    @State private var rowSheet: RowSheet?
    @State private var now = Date()

    private enum RowSheet: Identifiable {
        case rename(MobileThreadEntry)
        case archive(MobileThreadEntry)

        var id: String {
            switch self {
            case .rename(let thread): "rename:\(thread.id)"
            case .archive(let thread): "archive:\(thread.id)"
            }
        }
    }

    private struct ActivitySection: Identifiable {
        var key: KeyPath<MobileActivity, [MobileThreadEntry]>
        var id: String
        var label: String
    }

    /// The activity list's sections, in the order the desktop draws them.
    private static let sections = [
        ActivitySection(key: \.priority, id: "priority", label: "Priority"),
        ActivitySection(key: \.running, id: "running", label: "Running"),
        ActivitySection(key: \.threads, id: "threads", label: "Threads"),
        ActivitySection(key: \.snoozed, id: "snoozed", label: "Snoozed"),
    ]

    private var projects: [MobileProjectGroup] { model.view.groups.filter { $0.projectId != nil } }
    /// A project the computer no longer lists narrows nothing.
    private var narrowed: MobileProjectGroup? { projects.first { $0.projectId == model.activityProject } }

    private var shown: MobileActivity {
        guard let project = narrowed?.projectId else { return model.view.activity }
        let keep: (MobileThreadEntry) -> Bool = { $0.projectId == project }
        let activity = model.view.activity
        return MobileActivity(priority: activity.priority.filter(keep), running: activity.running.filter(keep), threads: activity.threads.filter(keep), snoozed: activity.snoozed.filter(keep))
    }

    private var bare: Bool { !model.view.groups.contains { !$0.threads.isEmpty } }

    var body: some View {
        let activity = shown
        List {
            if !projects.isEmpty {
                Button { picking = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "folder")
                        Text(narrowed?.name ?? "All projects").lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(narrowed != nil ? palette.accent : palette.inkDim)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .overlay(Capsule().strokeBorder(narrowed != nil ? palette.accentLine : palette.lineStrong))
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 0, trailing: 16))
                .accessibilityLabel("Show threads in \(narrowed?.name ?? "all projects")")
            }
            ForEach(Self.sections) { section in
                let threads = activity[keyPath: section.key]
                if section.id != "snoozed" || !threads.isEmpty {
                    sectionView(id: section.id, label: section.label, threads: threads, activity: activity)
                }
            }
            if bare {
                VStack(spacing: 12) {
                    Text("No threads yet").foregroundStyle(palette.muted)
                    Button("Start a thread") { model.newThread(projectId: nil, project: nil) }
                        .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        // Row separators keep the tint they were first drawn with, so a theme change redraws the list.
        .id(palette.id)
        .scrollContentBackground(.hidden)
        .screenBackground(palette)
        .notice(model)
        .navigationTitle("Threads")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ConnectionMark(connection: model.state.connection) }
            ToolbarItem(placement: .topBarTrailing) {
                let start = model.startingProject
                Button { model.newThread(projectId: start?.projectId, project: start?.name) } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel(start.map { "New thread in \($0.name)" } ?? "New thread")
            }
        }
        .sheet(isPresented: $picking) {
            ProjectSheet(projects: projects, selected: narrowed?.projectId, none: "All projects", label: "Show threads in") { projectId in
                model.activityProject = projectId
            }
        }
        .sheet(item: $rowSheet) { sheet in
            switch sheet {
            case .rename(let thread):
                RenameSheet(title: thread.title) { title in model.send(.rename(thread.id, title: title)) }
            case .archive(let thread):
                ArchiveSheet(title: thread.title, running: thread.status == "running" || thread.status == "awaiting-approval") { model.archive(thread.id, leaving: false) }
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                now = Date()
            }
        }
    }

    @ViewBuilder
    private func sectionView(id: String, label: String, threads: [MobileThreadEntry], activity: MobileActivity) -> some View {
        let key = "activity:\(id)"
        let open = !model.folded.contains(key)
        let dismissable = id == "priority" ? activity.priority.filter(\.attention) : []
        Section {
            if open {
                ForEach(threads) { thread in
                    ThreadRow(thread: thread, meta: Format.activityMeta(thread, now: now), dismissable: id == "priority" && thread.attention, model: model) { sheet in
                        rowSheet = sheet == .rename ? .rename(thread) : .archive(thread)
                    }
                }
                if threads.isEmpty, id == "priority", !bare {
                    Text("Nothing waiting")
                        .font(.subheadline)
                        .foregroundStyle(palette.quiet)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
        } header: {
            HStack(spacing: 8) {
                Button { withAnimation(.snappy) { model.toggleFolded(key) } } label: {
                    HStack(spacing: 6) {
                        Text(label).font(.footnote.weight(.semibold)).foregroundStyle(palette.muted)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(palette.quiet)
                            .rotationEffect(.degrees(open ? 0 : -90))
                        if !open, let mark = Format.groupMark(threads) {
                            StatusDot(kind: mark == .needsYou ? .needsYou : .unread)
                                .accessibilityLabel(mark == .needsYou ? "Needs you" : "Unread")
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                Spacer()
                if !dismissable.isEmpty {
                    Button("Dismiss all") { model.dismissAll(projectId: narrowed?.projectId) }
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                }
            }
            .textCase(nil)
        }
    }
}

enum RowSheetKind { case rename, archive }

struct ThreadRow: View {
    var thread: MobileThreadEntry
    var meta: String
    var dismissable: Bool
    var model: PhoneModel
    var onSheet: (RowSheetKind) -> Void
    @Environment(\.palette) private var palette

    private var needsYou: Bool { thread.status == "awaiting-approval" || thread.waiting == true }

    var body: some View {
        HStack(spacing: 10) {
            Button { model.openThread(thread.id, title: thread.title, project: thread.projectName) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(thread.title)
                        .font(.body.weight(thread.unread ? .semibold : .regular))
                        .foregroundStyle(palette.ink)
                        .lineLimit(1)
                    if let headline = thread.headline {
                        Text(headline).font(.subheadline).foregroundStyle(palette.inkDim).lineLimit(2)
                    }
                    Text(meta).font(.caption).foregroundStyle(palette.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if !dismissable || needsYou {
                mark.frame(width: 22, height: 22)
            }
            if dismissable {
                Button { model.dismiss(thread.id) } label: {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.muted)
                        .frame(width: 26, height: 26)
                        .overlay(Circle().strokeBorder(palette.lineStrong))
                        .frame(width: 36, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss \(thread.title)")
            }
            Menu { menuItems } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(palette.muted)
                    .frame(width: 32, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Options for \(thread.title)")
        }
        .padding(.vertical, 2)
        .listRowBackground(palette.canvas)
        .listRowSeparatorTint(palette.lineSoft)
        .contextMenu { menuItems }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { onSheet(.archive) } label: { Label("Archive", systemImage: "archivebox") }
            if dismissable {
                Button { model.dismiss(thread.id) } label: { Label("Dismiss", systemImage: "checkmark") }
                    .tint(palette.success)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue([needsYou ? "Needs you" : nil, thread.status == "running" && !needsYou ? "Running" : nil, thread.unread ? "Unread" : nil].compactMap { $0 }.joined(separator: ", "))
    }

    @ViewBuilder private var mark: some View {
        if needsYou {
            StatusDot(kind: .needsYou)
        } else if thread.status == "running" {
            ProgressView().controlSize(.small)
        } else if thread.unread, thread.status == "idle" {
            StatusDot(kind: .unread)
        } else if thread.unread, thread.status == "stopped" {
            RoundedRectangle(cornerRadius: 2).fill(palette.mutedStrong).frame(width: 8, height: 8)
        } else {
            Color.clear
        }
    }

    @ViewBuilder private var menuItems: some View {
        Button { model.openThread(thread.id, title: thread.title, project: thread.projectName) } label: { Label("Open", systemImage: "text.bubble") }
        Divider()
        Button { onSheet(.rename) } label: { Label("Rename…", systemImage: "pencil.line") }
        Button { model.send(.fork(thread.id, worktree: false)) } label: { Label("Fork thread", systemImage: "arrow.triangle.branch") }
        Divider()
        if thread.attention {
            Button { model.dismiss(thread.id) } label: { Label("Dismiss from Priority", systemImage: "checkmark") }
        }
        Button(role: .destructive) { onSheet(.archive) } label: { Label("Archive…", systemImage: "archivebox") }
    }
}

struct StatusDot: View {
    enum Kind { case needsYou, unread }
    var kind: Kind
    @Environment(\.palette) private var palette

    var body: some View {
        switch kind {
        case .needsYou: Circle().strokeBorder(palette.accent, lineWidth: 2).frame(width: 10, height: 10)
        case .unread: Circle().fill(palette.info).frame(width: 8, height: 8)
        }
    }
}
