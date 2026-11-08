import SwiftUI

/// The activity list, ranked the way the desktop's sidebar ranks it: what wants the user first.
struct ThreadListScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var picking = false
    @State private var renaming: MobileThreadEntry?
    @State private var archiving: ArchiveAsk?
    @State private var now = Date()
    @State private var query = ""

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

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    private var shown: MobileActivity {
        let project = narrowed?.projectId
        let wanted = query.trimmingCharacters(in: .whitespaces)
        guard project != nil || !wanted.isEmpty else { return model.view.activity }
        let keep: (MobileThreadEntry) -> Bool = { entry in
            (project == nil || entry.projectId == project) && (wanted.isEmpty || [entry.title, entry.headline ?? "", entry.projectName ?? ""].contains { $0.localizedCaseInsensitiveContains(wanted) })
        }
        let activity = model.view.activity
        return MobileActivity(priority: activity.priority.filter(keep), running: activity.running.filter(keep), threads: activity.threads.filter(keep), snoozed: activity.snoozed.filter(keep))
    }

    private var bare: Bool { !model.view.groups.contains { !$0.threads.isEmpty } }

    var body: some View {
        let activity = shown
        List {
            if !projects.isEmpty {
                projectFilter
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 6, trailing: 16))
            }
            if bare {
                EmptyList { model.newThread(projectId: nil, project: nil) }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else if searching, activity.priority.isEmpty, activity.running.isEmpty, activity.threads.isEmpty, activity.snoozed.isEmpty {
                ContentUnavailableView.search(text: query.trimmingCharacters(in: .whitespaces))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .padding(.top, 40)
            } else {
                ForEach(Self.sections) { section in
                    let threads = activity[keyPath: section.key]
                    if (section.id != "snoozed" && !searching) || !threads.isEmpty {
                        sectionView(id: section.id, label: section.label, threads: threads, activity: activity)
                    }
                }
            }
        }
        .listStyle(.plain)
        .hardTopEdge()
        .listSectionSpacing(0)
        .environment(\.defaultMinListRowHeight, 0)
        // Row separators keep the tint they were first drawn with, so a theme change redraws the list.
        .id(palette.id)
        .scrollContentBackground(.hidden)
        .screenBackground(palette)
        .notice(model)
        .navigationTitle("Threads")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, prompt: "Search threads")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ComputerMenu(model: model) }
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
        .sheet(item: $renaming) { thread in
            RenameSheet(title: thread.title) { title in model.send(.rename(thread.id, title: title)) }
        }
        .archiveConfirmation($archiving) { asked in model.archive(asked.id, leaving: false) }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                now = Date()
            }
        }
    }

    private var projectFilter: some View {
        Button { picking = true } label: {
            HStack(spacing: 6) {
                Image(systemName: narrowed != nil ? "folder.fill" : "folder")
                    .font(.footnote.weight(.semibold))
                Text(narrowed?.name ?? "All projects").lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.7)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(narrowed != nil ? palette.accent : palette.inkDim)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(narrowed != nil ? palette.accentChip : palette.surface, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show threads in \(narrowed?.name ?? "all projects")")
    }

    @ViewBuilder
    private func sectionView(id: String, label: String, threads: [MobileThreadEntry], activity: MobileActivity) -> some View {
        let key = "activity:\(id)"
        let open = !model.folded.contains(key)
        let dismissable = id == "priority" ? activity.priority.filter(\.attention) : []
        Section {
            SectionHeading(label: label, count: threads.count, open: open, mark: open ? nil : Format.groupMark(threads), onToggle: {
                withAnimation(.snappy) { model.toggleFolded(key) }
            }, onDismissAll: dismissable.isEmpty ? nil : { model.dismissAll(projectId: narrowed?.projectId) })
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: id == "priority" ? 12 : 26, leading: 16, bottom: 2, trailing: 16))
            if open {
                ForEach(threads) { thread in
                    ThreadRow(thread: thread, now: now, dismissable: id == "priority" && thread.attention, model: model) { sheet in
                        if sheet == .rename {
                            renaming = thread
                        } else {
                            archiving = ArchiveAsk(id: thread.id, title: thread.title, running: thread.status == "running" || thread.status == "awaiting-approval")
                        }
                    }
                }
                if threads.isEmpty, id == "priority" {
                    Label("Nothing needs you", systemImage: "checkmark.circle")
                        .font(.subheadline)
                        .foregroundStyle(palette.quiet)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                }
            }
        }
    }
}

/// A section's title, which folds it, with its count and, while open, the way to clear it.
private struct SectionHeading: View {
    var label: String
    var count: Int
    var open: Bool
    var mark: Format.GroupMark?
    var onToggle: () -> Void
    var onDismissAll: (() -> Void)?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button(action: onToggle) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(label).font(.headline).foregroundStyle(palette.ink)
                    if count > 0 {
                        Text("\(count)").font(.subheadline.weight(.medium).monospacedDigit()).foregroundStyle(palette.muted)
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.quiet)
                        .rotationEffect(.degrees(open ? 0 : -90))
                    if let mark {
                        StatusDot(kind: mark == .needsYou ? .needsYou : .unread)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            .accessibilityLabel(mark == .needsYou ? "Needs you" : "Unread")
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            Spacer(minLength: 8)
            if let onDismissAll {
                Button("Dismiss All", action: onDismissAll)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(palette.accent)
                    .buttonStyle(.plain)
            }
        }
    }
}

/// What the list shows before the computer has any threads.
private struct EmptyList: View {
    var onStart: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(palette.quiet)
            VStack(spacing: 4) {
                Text("No threads yet").font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
                Text("Start one here or on your computer.").font(.subheadline).foregroundStyle(palette.muted)
            }
            Button("Start a Thread", action: onStart)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 72)
    }
}

enum RowSheetKind { case rename, archive }

struct ThreadRow: View {
    var thread: MobileThreadEntry
    var now: Date
    var dismissable: Bool
    var model: PhoneModel
    var onSheet: (RowSheetKind) -> Void
    @Environment(\.palette) private var palette

    private var needsYou: Bool { thread.status == "awaiting-approval" || thread.waiting == true }
    private var running: Bool { thread.status == "running" && !needsYou }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button { model.openThread(thread.id, title: thread.title, project: thread.projectName) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    mark.frame(width: 14)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(thread.title.isEmpty ? "Untitled thread" : thread.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.ink)
                            .lineLimit(1)
                        if let headline = thread.headline {
                            Text(headline)
                                .font(.subheadline)
                                .foregroundStyle(palette.inkDim)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        meta
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            VStack(alignment: .trailing, spacing: 8) {
                Text(Format.relativeTime(thread.lastActivityAt, now: now))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(palette.muted)
                    .padding(.top, 1)
                if dismissable {
                    Button { model.dismiss(thread.id) } label: {
                        Image(systemName: "checkmark.circle")
                            .font(.title3)
                            .foregroundStyle(palette.muted)
                            .frame(width: 44, height: 36, alignment: .trailing)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss \(thread.title)")
                }
            }
        }
        .padding(.vertical, 10)
        .listRowInsets(EdgeInsets(top: 0, leading: 9, bottom: 0, trailing: 16))
        .alignmentGuide(.listRowSeparatorLeading) { _ in 30 }
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(palette.lineSoft)
        .contextMenu { menuItems }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { onSheet(.archive) } label: { Label("Archive", systemImage: "archivebox") }
            if thread.attention {
                Button { model.dismiss(thread.id) } label: { Label("Dismiss", systemImage: "checkmark") }
                    .tint(palette.success)
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button { onSheet(.rename) } label: { Label("Rename", systemImage: "pencil") }
                .tint(palette.info)
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue([needsYou ? "Needs you" : nil, running ? "Running" : nil, thread.unread ? "Unread" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAction(named: "Fork") { model.send(.fork(thread.id, worktree: false)) }
    }

    /// The project, then what the thread is doing; a thread that needs the user says so in the accent.
    private var meta: some View {
        let state = needsYou ? "Needs you" : Format.stateLabel(thread)
        return (Text(thread.projectName ?? "No project").foregroundStyle(palette.muted)
            + Text(state.map { " · \($0)" } ?? "").foregroundStyle(needsYou ? palette.accent : palette.muted))
            .font(.footnote)
            .lineLimit(1)
    }

    @ViewBuilder private var mark: some View {
        if needsYou {
            StatusDot(kind: .needsYou)
        } else if running {
            RunningMark()
        } else if thread.unread, thread.status == "stopped" {
            RoundedRectangle(cornerRadius: 2).fill(palette.mutedStrong).frame(width: 8, height: 8)
        } else if thread.unread {
            StatusDot(kind: .unread)
        } else if thread.attention, thread.outcome == "finished" {
            Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(palette.success)
        } else if thread.attention, thread.outcome == "failed" {
            Image(systemName: "exclamationmark.circle.fill").font(.caption).foregroundStyle(palette.danger)
        } else {
            Color.clear.frame(height: 8)
        }
    }

    @ViewBuilder private var menuItems: some View {
        Button { model.openThread(thread.id, title: thread.title, project: thread.projectName) } label: { Label("Open", systemImage: "text.bubble") }
        Divider()
        Button { onSheet(.rename) } label: { Label("Rename…", systemImage: "pencil") }
        Button { model.send(.fork(thread.id, worktree: false)) } label: { Label("Fork Thread", systemImage: "arrow.triangle.branch") }
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
        case .needsYou:
            Circle().fill(palette.accent).frame(width: 9, height: 9)
                .background(Circle().fill(palette.accent.opacity(0.25)).frame(width: 17, height: 17))
        case .unread: Circle().fill(palette.info).frame(width: 9, height: 9)
        }
    }
}

/// A thread at work.
struct RunningMark: View {
    @Environment(\.palette) private var palette

    var body: some View {
        ProgressView()
            .controlSize(.small)
            .tint(palette.inkDim)
            .scaleEffect(0.85)
            .frame(width: 14, height: 14)
            .accessibilityLabel("Working")
    }
}
