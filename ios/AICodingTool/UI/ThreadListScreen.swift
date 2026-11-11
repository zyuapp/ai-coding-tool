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
            if !searching, let archived = model.view.archived, archived > 0 {
                ArchivedLink(count: archived) { model.path.append(.archived) }
            }
        }
        .listStyle(.plain)
        .animation(.glide, value: activity)
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
        .barSubtitle(model.state.computerName)
        .searchable(text: $query, prompt: "Search Threads")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ComputerButton(model: model) }
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
        .archiveConfirmation($archiving, restorable: model.view.archived != nil) { asked in model.archive(asked.id, leaving: false) }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                now = Date()
            }
        }
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
        let first = Self.sections.first { !activity[keyPath: $0.key].isEmpty }?.id
        Section {
            SectionHeading(label: label, count: threads.count, open: open, mark: open ? nil : Format.groupMark(threads), onToggle: {
                withAnimation(.glide) { model.toggleFolded(key) }
            }, onDismissAll: dismissable.isEmpty || searching ? nil : { model.dismissAll(projectId: narrowed?.projectId) }, quiet: model.notice != nil)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: id == first ? 4 : 14, leading: ThreadRow.leading, bottom: 2, trailing: Space.page))
            if open {
                ForEach(threads) { thread in
                    ThreadRow(thread: thread, now: now, snoozed: id == "snoozed", last: thread.id == threads.last?.id, model: model, onRename: { renaming = thread }, onArchive: { archiving = $0 })
                }
            }
        }
    }
}

/// A section's title, which folds it, with its count and, while open, the way to clear it. Its
/// chevron sits in the gutter, so the label starts where the rows' titles do.
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
        HStack(alignment: .center, spacing: Space.s) {
            Button(action: onToggle) {
                HStack(alignment: .center, spacing: ThreadRow.spacing) {
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(palette.quiet)
                        .rotationEffect(.degrees(open ? 0 : -90))
                        .frame(width: Space.gutter)
                    Text(label).font(.footnote.weight(.semibold)).foregroundStyle(palette.mutedStrong)
                    if count > 0 {
                        Text("\(count)")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(palette.quiet)
                            .contentTransition(.numericText())
                    }
                    if let mark {
                        StatusDot(kind: mark == .needsYou ? .needsYou : .unread)
                            .padding(.leading, 2)
                            .transition(.pop)
                            .accessibilityLabel(mark == .needsYou ? "Needs you" : "Unread")
                    }
                }
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.target)
            .accessibilityAddTraits(.isHeader)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            Spacer(minLength: Space.s)
            if let onDismissAll {
                Button("Dismiss All", action: onDismissAll)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(quiet ? palette.inkDim : palette.accent)
                    .buttonStyle(.target)
            }
        }
    }
}

/// The way to the archive, below every section, as Mail keeps Recently Deleted below its mailboxes.
private struct ArchivedLink: View {
    var count: Int
    var onOpen: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: ThreadRow.spacing) {
                Image(systemName: "archivebox").font(.footnote.weight(.medium)).foregroundStyle(palette.muted).frame(width: Space.gutter)
                Text("Archived").font(.body).foregroundStyle(palette.inkSoft)
                Spacer(minLength: Space.s)
                Text("\(count)").font(.footnote.monospacedDigit()).foregroundStyle(palette.muted)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.quiet)
            }
            .padding(.vertical, Space.m)
        }
        .buttonStyle(RowPress())
        .listRowInsets(EdgeInsets(top: 18, leading: ThreadRow.leading, bottom: Space.s, trailing: Space.page))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .accessibilityValue(count == 1 ? "1 thread" : "\(count) threads")
    }
}

/// What the list shows before the computer has any threads.
private struct EmptyList: View {
    var onStart: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: Space.xl) {
            VStack(spacing: 6) {
                Text("No threads yet").font(.title2.weight(.semibold)).foregroundStyle(palette.ink)
                Text("Start one here, or on your computer.").font(.body).foregroundStyle(palette.muted)
            }
            .multilineTextAlignment(.center)
            Button(action: onStart) {
                ActionLabel(title: "New Thread", symbol: "square.and.pencil").frame(maxWidth: 220)
            }
            .buttonStyle(.press)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 96)
    }
}

struct ThreadRow: View {
    var thread: MobileThreadEntry
    var now: Date
    var snoozed = false
    /// The last row of its section, which draws no line beneath it.
    var last = false
    var model: PhoneModel
    var onRename: () -> Void
    var onArchive: (ArchiveAsk) -> Void
    @Environment(\.palette) private var palette

    /// Where a row begins, the gap after its gutter, and so where its text does.
    static let leading: CGFloat = 10
    static let spacing: CGFloat = 6
    static let textEdge = leading + Space.gutter + spacing

    private var needsYou: Bool { thread.status == "awaiting-approval" || thread.waiting == true }
    private var running: Bool { thread.status == "running" && !needsYou }
    /// A row with news for the user is set heavier than one they have read.
    private var fresh: Bool { needsYou || thread.unread || thread.attention }

    var body: some View {
        Button { model.openThread(thread.id, title: thread.title, project: thread.projectName) } label: {
            HStack(alignment: .firstTextBaseline, spacing: Self.spacing) {
                mark
                    .frame(width: Space.gutter)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5.5 }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(thread.title.isEmpty ? "Untitled thread" : thread.title)
                            .font(.body.weight(fresh ? .semibold : .regular))
                            .foregroundStyle(fresh ? palette.ink : palette.inkSoft)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Text(Format.relativeTime(thread.lastActivityAt, now: now))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(palette.muted)
                            .contentTransition(.numericText())
                            .layoutPriority(1)
                    }
                    if let headline = thread.headline {
                        Text(headline)
                            .font(.subheadline)
                            .foregroundStyle(palette.mutedStrong)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    meta
                }
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowPress())
        .listRowInsets(EdgeInsets(top: 0, leading: Self.leading, bottom: 0, trailing: Space.page))
        .alignmentGuide(.listRowSeparatorLeading) { _ in Space.gutter + Self.spacing }
        .alignmentGuide(.listRowSeparatorTrailing) { $0.width + Space.page }
        .listRowBackground(Color.clear)
        .listRowSeparator(last ? .hidden : .visible, edges: .bottom)
        .listRowSeparatorTint(palette.lineSoft)
        .contextMenu { menuItems }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
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
        let until = thread.snoozedUntil.map { "Snoozed until \(Format.liftTime($0, now: now))" } ?? "Snoozed"
        let state = needsYou ? "Needs you" : snoozed ? until : Format.stateLabel(thread)
        return (Text(thread.projectName ?? "No project").foregroundStyle(palette.muted)
            + Text(state == nil ? "" : " · ").foregroundStyle(palette.muted)
            + Text(state ?? "").foregroundStyle(needsYou ? palette.accent : !snoozed && thread.outcome == "failed" && thread.status == "idle" ? palette.danger : palette.muted))
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
            Image(systemName: "moon.zzz.fill").font(.caption).foregroundStyle(palette.quiet)
        } else if thread.attention, thread.outcome == "finished" {
            Image(systemName: "checkmark.circle.fill").font(.footnote).foregroundStyle(palette.success)
        } else if thread.attention, thread.outcome == "failed" {
            Image(systemName: "exclamationmark.circle.fill").font(.footnote).foregroundStyle(palette.danger)
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
        if thread.snoozable == true {
            Menu {
                ForEach(SnoozeOption.allCases) { option in
                    Button(option.label) { model.send(.snooze(thread.id, hours: option.hours)) }
                }
            } label: {
                Label("Snooze", systemImage: "moon.zzz")
            }
        } else if thread.snoozedUntil != nil {
            Button { model.send(.unsnooze(thread.id)) } label: { Label("Unsnooze", systemImage: "sun.max") }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathing = false

    var body: some View {
        switch kind {
        case .needsYou:
            Circle().fill(palette.accent).frame(width: 9, height: 9)
                .background {
                    Circle()
                        .fill(palette.accent.opacity(breathing ? 0.08 : 0.26))
                        .frame(width: 17, height: 17)
                        .scaleEffect(breathing ? 1.12 : 0.9)
                        .animation(reduceMotion ? nil : .easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: breathing)
                }
                .onAppear { breathing = true }
        case .unread: Circle().fill(palette.info).frame(width: 9, height: 9)
        }
    }
}

/// A thread at work.
struct RunningMark: View {
    var body: some View {
        Spinner(size: 13).accessibilityLabel("Working")
    }
}

/// A row that lights behind its content while pressed, as a system list row highlights.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Pressed(pressed: configuration.isPressed) { configuration.label.contentShape(Rectangle()) }
    }

    private struct Pressed<Label: View>: View {
        var pressed: Bool
        @ViewBuilder var label: Label
        @Environment(\.palette) private var palette

        var body: some View {
            label
                .background {
                    RoundedRectangle(cornerRadius: Radius.block, style: .continuous)
                        .fill(palette.raised)
                        .padding(.horizontal, -6)
                        .opacity(pressed ? 1 : 0)
                }
                .animation(.easeOut(duration: pressed ? 0.04 : 0.28), value: pressed)
        }
    }
}
