import SwiftUI

/// The activity list, ranked the way the desktop's sidebar ranks it: what wants the user first.
struct ThreadListScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
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

    /// The projects worth filtering by: those with threads, most recently active first, and the one already chosen.
    private var filterable: [MobileProjectGroup] {
        projects
            .filter { !$0.threads.isEmpty || $0.projectId == model.activityProject }
            .sorted { ($0.threads.map(\.lastActivityAt).max() ?? 0) > ($1.threads.map(\.lastActivityAt).max() ?? 0) }
    }
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
                    if !threads.isEmpty {
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
        .navigationTitle(narrowed?.name ?? "Threads")
        .navigationBarTitleDisplayMode(.large)
        .barSubtitle(computerLine)
        .searchable(text: $query, prompt: "Search Threads")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ComputerMenu(model: model) }
            if filterable.count > 1 || narrowed != nil {
                ToolbarItem(placement: .topBarTrailing) { projectFilter }
            }
            if #available(iOS 26, *) {
                DefaultToolbarItem(kind: .search, placement: .bottomBar)
                ToolbarSpacer(.fixed, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) { composeButton }
            } else {
                ToolbarItem(placement: .topBarTrailing) { composeButton }
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

    /// The computer the list is from, and its line when that is not live.
    private var computerLine: String? {
        let name = model.state.computerName ?? model.connection.computers.first { $0.origin == model.connection.origin }?.title
        let state = model.restarting ? "Restarting" : model.state.connection != .live ? model.state.connection.label : model.view.updateOffered ? "Update available" : nil
        let parts = [name, state].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var composeButton: some View {
        let start = model.startingProject
        return Button { model.newThread(projectId: start?.projectId, project: start?.name) } label: {
            Label("New Thread", systemImage: "square.and.pencil")
        }
        .tint(palette.ink)
        .accessibilityLabel(start.map { "New thread in \($0.name)" } ?? "New thread")
    }

    /// Which project's threads the list shows, picked like any other filter.
    private var projectFilter: some View {
        Menu {
            Picker("Show Threads In", selection: Binding(get: { narrowed?.projectId ?? "" }, set: { model.activityProject = $0.isEmpty ? nil : $0 })) {
                Text("All Projects").tag("")
                ForEach(filterable, id: \.projectId) { project in
                    Text(Format.middleTruncated(project.name, limit: 26)).tag(project.projectId ?? "")
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label("Filter by Project", systemImage: "line.3.horizontal.decrease")
        }
        // Tinted only while it narrows the list, which is what the color says.
        .tint(narrowed != nil ? palette.accent : palette.ink)
        .accessibilityValue(narrowed?.name ?? "All projects")
    }

    @ViewBuilder
    private func sectionView(id: String, label: String, threads: [MobileThreadEntry], activity: MobileActivity) -> some View {
        let key = "activity:\(id)"
        let open = !model.folded.contains(key)
        let dismissable = id == "priority" ? activity.priority.filter(\.attention) : []
        Section {
            SectionHeading(label: label, count: threads.count, open: open, mark: open ? nil : Format.groupMark(threads), onToggle: {
                withAnimation(.snappy) { model.toggleFolded(key) }
            }, onDismissAll: dismissable.isEmpty || searching ? nil : { model.dismissAll(projectId: narrowed?.projectId) }, quiet: model.notice != nil)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: id == "priority" ? 12 : 26, leading: 16, bottom: 2, trailing: 16))
            if open {
                ForEach(threads) { thread in
                    ThreadRow(thread: thread, now: now, snoozed: id == "snoozed", model: model, onRename: { renaming = thread }, onArchive: { archiving = $0 })
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
    var quiet = false
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
                    .foregroundStyle(quiet ? palette.inkDim : palette.accent)
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

struct ThreadRow: View {
    var thread: MobileThreadEntry
    var now: Date
    var snoozed = false
    var model: PhoneModel
    var onRename: () -> Void
    var onArchive: (ArchiveAsk) -> Void
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
                    Text(Format.relativeTime(thread.lastActivityAt, now: now))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(palette.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPress())
        }
        .padding(.vertical, 10)
        .listRowInsets(EdgeInsets(top: 0, leading: 9, bottom: 0, trailing: 16))
        .alignmentGuide(.listRowSeparatorLeading) { _ in 30 }
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(palette.lineSoft)
        .contextMenu { menuItems }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { askArchive() } label: { Label("Archive", systemImage: "archivebox") }
            Button(action: onRename) { Label("Rename", systemImage: "pencil") }
                .tint(palette.info)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if thread.attention {
                Button { model.dismiss(thread.id) } label: { Label("Dismiss", systemImage: "checkmark") }
                    .tint(palette.success)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityValue([needsYou ? "Needs you" : nil, running ? "Running" : nil, thread.unread ? "Unread" : nil].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAction(named: "Fork") { model.send(.fork(thread.id, worktree: false)) }
    }

    /// The project, then what the thread is doing; a thread that needs the user says so in the accent.
    private var meta: some View {
        let state = needsYou ? "Needs you" : snoozed ? "Snoozed" : Format.stateLabel(thread)
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
        } else if snoozed {
            Image(systemName: "moon.zzz.fill").font(.footnote).foregroundStyle(palette.muted)
        } else if thread.attention, thread.outcome == "finished" {
            Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(palette.success)
        } else if thread.attention, thread.outcome == "failed" {
            Image(systemName: "exclamationmark.circle.fill").font(.caption).foregroundStyle(palette.danger)
        } else {
            Color.clear.frame(height: 8)
        }
    }

    private func askArchive() {
        onArchive(ArchiveAsk(id: thread.id, title: thread.title, running: thread.status == "running" || thread.status == "awaiting-approval"))
    }

    @ViewBuilder private var menuItems: some View {
        if thread.attention {
            Section {
                Button { model.dismiss(thread.id) } label: { Label("Dismiss", systemImage: "checkmark.circle") }
            }
        }
        Section {
            Button(action: onRename) { Label("Rename…", systemImage: "pencil") }
            Button { model.send(.fork(thread.id, worktree: false)) } label: { Label("Fork", systemImage: "arrow.triangle.branch") }
        }
        Button(role: .destructive) { askArchive() } label: { Label("Archive…", systemImage: "archivebox") }
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
                .background(Circle().fill(palette.accent.opacity(0.22)).frame(width: 15, height: 15))
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

/// A row that dims while pressed, as a system list row highlights.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(.easeOut(duration: configuration.isPressed ? 0.05 : 0.2), value: configuration.isPressed)
    }
}
