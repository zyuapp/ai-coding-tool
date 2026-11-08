import SwiftUI

/// The thread the computer has open, the draft it is about to start, or the one the phone is waiting for.
struct ThreadScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var sheet: ThreadSheet?

    enum ThreadSheet: String, Identifiable {
        case settings, menu, location, rename, archive, project, startIn, members, addProject
        var id: String { rawValue }
    }

    private var thread: MobileThreadView? { model.pending ? nil : model.view.thread }
    private var draft: MobileDraftView? { model.pending || model.view.thread != nil ? nil : model.view.draft }

    private var title: String {
        if model.pending, let opening = model.opening { return opening.title }
        if let thread = model.view.thread { return thread.title.isEmpty ? "Untitled thread" : thread.title }
        if model.view.draft != nil { return "New thread" }
        return model.missed?.title ?? "Opening"
    }

    /// The bar's second line. The outer optional is whether there is a line at all; the inner is the project.
    private var project: String?? {
        if model.pending, let opening = model.opening { return .some(opening.project) }
        if let thread = model.view.thread { return .some(thread.projectName) }
        if let draft = model.view.draft { return .some(draft.projectName) }
        if let missed = model.missed { return .some(missed.project) }
        return nil
    }

    private var subtitle: String? {
        guard let project else { return nil }
        let name = project ?? "No project"
        if let thread, thread.location != .local { return "\(name) · \(Format.locationLabel(thread.location))" }
        return name
    }

    var body: some View {
        content
            .screenBackground(palette)
            .notice(model)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(title).font(.headline).foregroundStyle(palette.ink).lineLimit(1)
                        if let subtitle { Text(subtitle).font(.caption).foregroundStyle(palette.muted).lineLimit(1) }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    ConnectionMark(connection: model.state.connection)
                    if model.pending ? model.opening?.want != "draft" : model.view.thread != nil {
                        Button { sheet = .menu } label: { Image(systemName: "ellipsis.circle") }
                            .disabled(model.pending)
                            .accessibilityLabel("Thread options")
                    }
                }
            }
            .sheet(item: $sheet) { which in sheetView(which) }
            .onChange(of: model.current) { _, _ in
                if let sheet, !fits(sheet) { self.sheet = nil }
            }
    }

    @ViewBuilder private var content: some View {
        if let thread {
            VStack(spacing: 0) {
                if thread.settings.coordinating == true, let members = thread.members {
                    CoordinatorStrip(members: members) { sheet = .members }
                }
                ConversationView(thread: thread, model: model)
                if let approval = thread.approval {
                    ApprovalCard(approval: approval, refused: model.state.returned?.command.type == "run.decide" ? model.state.returned?.requestId : nil) { allow in
                        model.send(.decide(approval, allow: allow))
                    }
                    .id(approval.approvalId)
                }
                ComposerView(model: model, draftKey: thread.id, running: thread.status == "running", settings: thread.settings, question: thread.question, returned: returned(for: thread.id), onSend: { model.send(.send(thread.id, text: $0)) }, onSteer: { model.send(.send(thread.id, text: $0, steer: true)) }, onStop: { model.send(.cancel(thread.id)) }, onAnswer: { question, text in model.send(.answer(thread.id, question: question, text: text)) }, onSettings: { sheet = .settings })
            }
        } else if let draft {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ComposerView(model: model, draftKey: "draft", running: false, settings: draft.settings, question: nil, returned: nil, onSend: { text in
                    model.send(.setPrompt(text))
                    model.send(.send(nil, text: nil))
                }, onSteer: nil, onStop: nil, onAnswer: nil, onSettings: { sheet = .settings }) {
                    StartOptions(draft: draft, onPickProject: { sheet = .project }, onPickPlace: { sheet = .startIn }, onCoordinate: { model.send(.setCoordinator(nil, $0)) })
                }
            }
        } else if let missed = model.missed {
            VStack(spacing: 14) {
                Text("Couldn't open the thread").foregroundStyle(palette.muted)
                Button("Try again") { model.retryMissed() }.buttonStyle(.borderedProminent)
                    .accessibilityLabel("Try opening \(missed.title) again")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Text("Opening the thread…")
                .foregroundStyle(palette.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private var projects: [MobileProjectGroup] { model.view.groups.filter { $0.projectId != nil } }

    /// What the computer turned down here: a message's words, or the question it answered.
    private func returned(for taskId: String) -> ComposerReturned? {
        guard let returned = model.state.returned, returned.command.taskId == taskId else { return nil }
        if returned.command.type == "task.send", let text = returned.command.text { return .init(id: returned.requestId, text: text, answer: nil) }
        if returned.command.type == "question.answer" { return .init(id: returned.requestId, text: nil, answer: returned.command.questionId) }
        return nil
    }

    /// Whether what a sheet acts on is still open: a thread's own sheets need the thread, a draft's the draft.
    private func fits(_ sheet: ThreadSheet) -> Bool {
        switch sheet {
        case .settings: model.view.thread != nil || model.view.draft != nil
        case .menu, .location, .rename, .archive, .members: model.view.thread != nil
        case .project, .startIn: model.view.draft != nil
        case .addProject: true
        }
    }

    @ViewBuilder private func sheetView(_ which: ThreadSheet) -> some View {
        let catalog = model.catalog
        switch which {
        case .settings:
            if let thread = model.view.thread {
                ThreadSettingsSheet(settings: thread.settings, catalog: catalog, live: model.live, locked: true, onNewWith: { engine in
                    model.newThread(projectId: thread.projectId, project: thread.projectName, worktreeId: thread.worktreeId, then: [.setModel(nil, engine: engine, model: nil)])
                }, onPolicy: { model.send(.setPolicy(thread.id, policy: $0)) }, onModel: { model.send(.setModel(thread.id, engine: $0, model: $1)) }, onFastMode: { model.send(.setFastMode(thread.id, fastMode: $0)) }, onEffort: { model.send(.setEffort(thread.id, engine: $0, effort: $1)) })
            } else if let draft = model.view.draft {
                ThreadSettingsSheet(settings: draft.settings, catalog: catalog, live: model.live, locked: false, onNewWith: nil, onPolicy: { model.send(.setPolicy(nil, policy: $0)) }, onModel: { model.send(.setModel(nil, engine: $0, model: $1)) }, onFastMode: { model.send(.setFastMode(nil, fastMode: $0)) }, onEffort: { model.send(.setEffort(nil, engine: $0, effort: $1)) })
            }
        case .menu:
            if let thread = model.view.thread {
                ThreadMenuSheet(thread: thread, onChanges: { model.enterChanges() }, onLocation: { reopen(.location) }, onNewHere: {
                    model.newThread(projectId: thread.projectId, project: thread.projectName, worktreeId: thread.worktreeId)
                }, onFork: { worktree in model.send(.fork(thread.id, worktree: worktree)) }, onRename: { reopen(.rename) }, onArchive: { reopen(.archive) }, onCoordinate: { model.send(.setCoordinator(thread.id, $0)) })
            }
        case .location:
            if let thread = model.view.thread {
                LocationSheet(thread: thread) { model.send(.moveWorktree(thread.id, destination: $0)) }
            }
        case .rename:
            if let thread = model.view.thread {
                RenameSheet(title: thread.title) { model.send(.rename(thread.id, title: $0)) }
            }
        case .archive:
            if let thread = model.view.thread {
                ArchiveSheet(title: thread.title, running: thread.status == "running" || thread.status == "awaiting-approval") {
                    model.archive(thread.id, leaving: true)
                }
            }
        case .project:
            if let draft = model.view.draft {
                ProjectSheet(projects: projects, selected: draft.projectId, none: "No project", label: "Start in", onAddProject: { reopen(.addProject) }) { projectId in
                    if projectId != draft.projectId { model.newThread(projectId: projectId, project: projects.first { $0.projectId == projectId }?.name) }
                }
            }
        case .addProject:
            AddProjectSheet(model: model)
        case .members:
            if let thread = model.view.thread {
                MembersSheet(model: model, members: thread.members ?? [], engine: thread.settings.engine)
            }
        case .startIn:
            if let draft = model.view.draft {
                StartInSheet(draft: draft, onSetWorktree: { model.send(.setWorktree($0)) }, onStartIn: { worktreeId in
                    model.newThread(projectId: draft.projectId, project: draft.projectName, worktreeId: worktreeId)
                })
            }
        }
    }

    /// One sheet hands over to the next once it has gone.
    private func reopen(_ next: ThreadSheet) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            sheet = next
        }
    }
}

/// Where a draft starts: which project, and within it which checkout.
struct StartOptions: View {
    var draft: MobileDraftView
    var onPickProject: () -> Void
    var onPickPlace: () -> Void
    var onCoordinate: (Bool) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let fresh = draft.worktree && draft.worktreeName == nil
        let local = !draft.worktree && draft.worktreeName == nil
        let choosing = draft.canWorktree || !draft.worktrees.isEmpty || draft.worktreeName != nil
        let coordinating = draft.settings.coordinating == true
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(draft.projectName ?? "No project", symbol: "folder", chosen: false, action: onPickProject)
                    .accessibilityLabel("Project: \(draft.projectName ?? "None")")
                if draft.projectId != nil, choosing {
                    chip(draft.worktreeName ?? (fresh ? "New worktree" : "Worktree"), symbol: "folder.badge.gearshape", chosen: !local, action: onPickPlace)
                }
                Button { onCoordinate(!coordinating) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "person.3")
                        Text("Coordinate")
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(coordinating ? palette.accent : palette.inkDim)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(coordinating ? palette.accentChip : palette.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(coordinating ? palette.accentLine : palette.line))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(coordinating ? [.isSelected] : [])
                .accessibilityHint("A coordinator starts and steers threads of its own")
            }
            .padding(.horizontal, 12)
        }
        .padding(.bottom, 8)
    }

    @ViewBuilder private func chip(_ label: String, symbol: String, chosen: Bool, action: (() -> Void)?) -> some View {
        let content = HStack(spacing: 5) {
            Image(systemName: symbol)
            Text(label).lineLimit(1)
            if action != nil { Image(systemName: "chevron.down").font(.caption2.weight(.bold)) }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(chosen ? palette.accent : palette.inkDim)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(chosen ? palette.accentChip : palette.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(chosen ? palette.accentLine : palette.line))
        if let action {
            Button(action: action) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }
}

/// The one thing a phone is most often picked up for. Both answers are full-width, and one tap
/// decides: the chosen answer spins and both are disabled until the computer takes the card away.
struct ApprovalCard: View {
    var approval: MobileApproval
    var refused: String?
    var onDecide: (Bool) -> Void
    @Environment(\.palette) private var palette
    @State private var decided: Bool?
    @State private var released: String?
    @State private var detailOpen: Bool

    init(approval: MobileApproval, refused: String?, onDecide: @escaping (Bool) -> Void) {
        self.approval = approval
        self.refused = refused
        self.onDecide = onDecide
        _detailOpen = State(initialValue: Format.glanceable(approval.detail))
        _released = State(initialValue: refused)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.shield")
                    .foregroundStyle(palette.accent)
                    .frame(width: 28, height: 28)
                    .background(palette.accentChip, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    if let from = approval.from { Text(from).font(.caption).foregroundStyle(palette.muted) }
                    Text(approval.title).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    Text(approval.description).font(.footnote).foregroundStyle(palette.inkDim)
                }
            }
            if !approval.detail.isEmpty {
                DisclosureGroup(isExpanded: $detailOpen) {
                    ScrollView {
                        Text(approval.detail)
                            .font(.caption.monospaced())
                            .foregroundStyle(palette.codeInk)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(maxHeight: 160)
                    .background(palette.codeSurface, in: RoundedRectangle(cornerRadius: 8))
                } label: {
                    Text(ToolNames.label(approval.toolName)).font(.footnote.weight(.medium)).foregroundStyle(palette.muted)
                }
                .tint(palette.muted)
            }
            HStack(spacing: 10) {
                decision(allow: false)
                decision(allow: true)
            }
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(palette.accentLine))
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .onChange(of: refused) { _, next in
            if let next, next != released {
                released = next
                decided = nil
            }
        }
    }

    private func decision(allow: Bool) -> some View {
        let chosen = decided == allow
        return Button {
            decided = allow
            onDecide(allow)
        } label: {
            HStack(spacing: 6) {
                if chosen { ProgressView().controlSize(.small).tint(allow ? palette.accentInk : palette.ink) }
                Text(chosen ? (allow ? "Allowing…" : "Denying…") : (allow ? "Allow once" : "Deny"))
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(allow ? palette.accentInk : palette.ink)
            .background(allow ? palette.accent : palette.raised, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(decided != nil)
        .opacity(decided != nil && !chosen ? 0.45 : 1)
    }
}

/// A coordinator's threads at a glance, above its conversation: how many, and how many work or wait.
private struct CoordinatorStrip: View {
    var members: [MobileMember]
    var onOpen: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        let working = members.filter { $0.status == "running" }.count
        let waiting = members.filter { $0.status == "awaiting-approval" }.count
        Button(action: onOpen) {
            HStack(spacing: 8) {
                Image(systemName: "person.3").font(.footnote).foregroundStyle(palette.accent)
                Text(members.isEmpty ? "Coordinating · no threads yet" : "Coordinating \(members.count) \(members.count == 1 ? "thread" : "threads")")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(palette.inkDim)
                if waiting > 0 { Text("· \(waiting) need you").font(.footnote).foregroundStyle(palette.accent) }
                if working > 0 { Text("· \(working) working").font(.footnote).foregroundStyle(palette.muted) }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(palette.quiet)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(palette.sunken)
            .overlay(alignment: .bottom) { palette.lineSoft.frame(height: 0.5) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows the threads it coordinates")
    }
}
