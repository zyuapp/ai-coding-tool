import SwiftUI

/// The thread the computer has open, the draft it is about to start, or the one the phone is waiting for.
struct ThreadScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var sheet: ThreadSheet?
    @State private var archiving: ArchiveAsk?

    enum ThreadSheet: String, Identifiable {
        case settings, location, rename, project, startIn, members, background, addProject
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

    /// The bar's second line: where the thread works, and the line to the computer when it is down.
    private var subtitle: String? {
        var parts: [String] = []
        if let project { parts.append(project ?? "No project") }
        if let thread, thread.location != .local { parts.append(Format.locationLabel(thread.location)) }
        if model.state.connection != .live { parts.append(model.state.connection.label) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        content
            .screenBackground(palette)
            .notice(model)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .barSubtitle(subtitle)
            .toolbarTitleMenu {
                if let thread { titleMenu(thread) }
            }
            .toolbar {
                if #unavailable(iOS 26) {
                    LegacyBarTitle(title: title, subtitle: subtitle)
                }
                if let thread {
                    if thread.reviewable {
                        ToolbarItem(placement: .topBarTrailing) { changesButton(thread).badge(thread.changes?.files ?? 0) }
                    }
                }
            }
            .sheet(item: $sheet) { which in sheetView(which) }
            .archiveConfirmation($archiving) { asked in
                if model.view.thread?.id == asked.id { model.archive(asked.id, leaving: true) }
            }
            .onChange(of: model.current) { _, _ in
                if let sheet, !fits(sheet) { self.sheet = nil }
                if let archiving, archiving.id != model.view.thread?.id { self.archiving = nil }
            }
    }

    private func changesButton(_ thread: MobileThreadView) -> some View {
        Button("Changes") { model.enterChanges() }
            .tint(palette.ink)
        .accessibilityValue(Format.changesLabel(thread.changes) ?? "")
    }

    /// The thread as a document: what changes it as a whole, behind its title, as Apple's document menus hold them.
    @ViewBuilder private func titleMenu(_ thread: MobileThreadView) -> some View {
        let inProject = thread.projectId != nil
        let moving = thread.location == .creating || thread.location == .releasing
        let roles = model.catalog.roles
        let role = thread.role ?? (thread.settings.coordinating == true ? "coordinator" : nil)
        Section {
            Button { sheet = .rename } label: { Label("Rename…", systemImage: "pencil") }
            if inProject {
                Button { sheet = .location } label: {
                    Label("Move…", systemImage: "folder")
                    Text(Format.locationLabel(thread.location))
                }
                .disabled(moving)
            }
            if inProject {
                Button {
                    model.newThread(projectId: thread.projectId, project: thread.projectName, worktreeId: thread.worktreeId)
                } label: {
                    Label("New Thread", systemImage: "square.and.pencil")
                }
                .disabled(moving)
            }
            Button { model.send(.fork(thread.id, worktree: false)) } label: { Label("Fork", systemImage: "arrow.triangle.branch") }
            if inProject {
                Button { model.send(.fork(thread.id, worktree: true)) } label: { Label("Fork in New Worktree", systemImage: "folder.badge.plus") }
                    .disabled(moving)
            }
        }
        Section {
            Picker(selection: Binding(get: { role ?? "" }, set: { model.send(.setRole(thread.id, role: $0.isEmpty ? nil : $0)) })) {
                ForEach(roles) { Text($0.label).tag($0.id) }
                Text("None").tag("")
            } label: {
                Label("Role", systemImage: "person.2")
                Text(role.map { id in roles.first { $0.id == id }?.label ?? id.capitalized } ?? "None")
            }
            .pickerStyle(.menu)
            if let background = thread.background, !background.isEmpty {
                let live = BackgroundWork.summary(background)
                Button { sheet = .background } label: {
                    Label("Background Work", systemImage: "square.stack.3d.up")
                    Text(live.isEmpty ? "Nothing running" : live)
                }
            }
        }
        Section {
            Button(role: .destructive) {
                archiving = ArchiveAsk(id: thread.id, title: thread.title, running: thread.status == "running" || thread.status == "awaiting-approval")
            } label: {
                Label("Archive…", systemImage: "archivebox")
            }
        }
    }

    @ViewBuilder private var content: some View {
        if let thread {
            VStack(spacing: 0) {
                if thread.settings.coordinating == true, let members = thread.members {
                    CoordinatorStrip(members: members) { sheet = .members }
                }
                if let background = thread.background, background.contains(where: \.live) {
                    BackgroundStrip(items: background) { sheet = .background }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                ConversationView(thread: thread, model: model)
                    .bottomBar {
                        VStack(spacing: 0) {
                            if let approval = thread.approval {
                                ApprovalCard(approval: approval, engine: thread.settings.engine, refused: model.state.returned?.command.type == "run.decide" ? model.state.returned?.requestId : nil) { allow in
                                    model.send(.decide(approval, allow: allow))
                                }
                                .id(approval.approvalId)
                                .fitsShortScreens()
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                            }
                            ComposerView(model: model, draftKey: thread.id, running: thread.status == "running", settings: thread.settings, question: thread.question, returned: returned(for: thread.id), onSend: { model.send(.message(thread.id, text: $0, sources: $1)) }, onSteer: { model.send(.message(thread.id, text: $0, sources: $1, steer: true)) }, onStop: { model.send(.cancel(thread.id)) }, onAnswer: { question, text in model.send(.answer(thread.id, question: question, text: text)) }, onSettings: { sheet = .settings }, quick: QuickSettings(locked: true, onPolicy: { model.send(.setPolicy(thread.id, policy: $0)) }, onModel: { model.send(.setModel(thread.id, engine: $0, model: $1)) }, onEffort: { model.send(.setEffort(thread.id, engine: $0, effort: $1)) }, onFastMode: { model.send(.setFastMode(thread.id, fastMode: $0)) }))
                                .id(thread.id)
                        }
                    }
            }
            .animation(.snappy, value: thread.approval?.approvalId)
            .animation(.snappy, value: thread.background?.contains(where: \.live) == true)
        } else if let draft {
            VStack(spacing: 0) {
                DraftWelcome(engine: model.catalog.engineLabel(draft.settings.engine), computer: model.state.computerName) { model.handBack($0) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                ComposerView(model: model, draftKey: "draft", running: false, settings: draft.settings, question: nil, returned: nil, onSend: { text, sources in
                    if sources.isEmpty {
                        model.send(.setPrompt(text))
                        model.send(.send(nil, text: nil))
                    } else {
                        model.send(.sendImages(nil, text: text, sources: sources))
                    }
                }, onSteer: nil, onStop: nil, onAnswer: nil, onSettings: { sheet = .settings }, quick: QuickSettings(locked: false, onPolicy: { model.send(.setPolicy(nil, policy: $0)) }, onModel: { model.send(.setModel(nil, engine: $0, model: $1)) }, onEffort: { model.send(.setEffort(nil, engine: $0, effort: $1)) }, onFastMode: { model.send(.setFastMode(nil, fastMode: $0)) })) {
                    StartOptions(draft: draft, onPickProject: { sheet = .project }, onPickPlace: { sheet = .startIn }, onCoordinate: { model.send(.setCoordinator(nil, $0)) })
                }
            }
        } else if let missed = model.missed {
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.bubble").font(.system(size: 36, weight: .light)).foregroundStyle(palette.quiet)
                Text("Couldn't open the thread").font(.headline).foregroundStyle(palette.ink)
                Button("Try Again") { model.retryMissed() }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .accessibilityLabel("Try opening \(missed.title) again")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 12) {
                ProgressView().tint(palette.muted)
                Text("Opening the thread…").font(.subheadline).foregroundStyle(palette.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private var projects: [MobileProjectGroup] { model.view.groups.filter { $0.projectId != nil } }

    /// What the computer turned down here: a message's words, or the question it answered.
    private func returned(for taskId: String) -> ComposerReturned? {
        guard let returned = model.state.returned, returned.command.taskId == taskId else { return nil }
        if returned.command.type == "task.send" || returned.command.type == "attachments.send", let text = returned.command.text { return .init(id: returned.requestId, text: text, answer: nil) }
        if returned.command.type == "question.answer" { return .init(id: returned.requestId, text: nil, answer: returned.command.questionId) }
        return nil
    }

    /// Whether what a sheet acts on is still open: a thread's own sheets need the thread, a draft's the draft.
    private func fits(_ sheet: ThreadSheet) -> Bool {
        switch sheet {
        case .settings: model.view.thread != nil || model.view.draft != nil
        case .location, .rename, .members, .background: model.view.thread != nil
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
        case .location:
            if let thread = model.view.thread {
                LocationSheet(thread: thread) { model.send(.moveWorktree(thread.id, destination: $0)) }
            }
        case .rename:
            if let thread = model.view.thread {
                RenameSheet(title: thread.title) { model.send(.rename(thread.id, title: $0)) }
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
                MembersSheet(model: model, members: thread.members ?? [], project: thread.projectName)
            }
        case .background:
            if let thread = model.view.thread {
                BackgroundSheet(items: thread.background ?? []) { model.send(.stopProcess(thread.id, processId: $0)) }
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

/// The empty page above a new thread's composer: where it starts, and with whom.
struct DraftWelcome: View {
    var engine: String
    var computer: String?
    var onSuggest: (String) -> Void
    @Environment(\.palette) private var palette

    private static let suggestions: [(symbol: String, text: String)] = [
        ("checkmark.seal", "Find and fix the failing tests"),
        ("plus.forwardslash.minus", "Review my uncommitted changes"),
        ("map", "Explain how this project is put together"),
    ]

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(palette.accent)
                .frame(width: 64, height: 64)
                .background(palette.accentChip, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            VStack(spacing: 6) {
                Text("What should \(engine) work on?")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .multilineTextAlignment(.center)
                Text(computer.map { "It runs on \($0), and you can follow along here." } ?? "It runs on your computer, and you can follow along here.")
                    .font(.subheadline)
                    .foregroundStyle(palette.muted)
                    .multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
            VStack(spacing: 8) {
                ForEach(Self.suggestions, id: \.text) { suggestion in
                    Button { onSuggest(suggestion.text) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: suggestion.symbol)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(palette.accent)
                                .frame(width: 22)
                            Text(suggestion.text).font(.subheadline).foregroundStyle(palette.ink)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(palette.surface, in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Puts this in the message box")
                }
            }
            .padding(.top, 10)
        }
        .frame(maxWidth: 420)
        .padding(.horizontal, 24)
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
            HStack(spacing: 6) {
                chip(draft.projectName ?? "No project", symbol: "folder", chosen: false, menu: true, action: onPickProject)
                    .accessibilityLabel("Project: \(draft.projectName ?? "None")")
                if draft.projectId != nil, choosing {
                    chip(draft.worktreeName ?? (fresh ? "New worktree" : "Local"), symbol: local ? "laptopcomputer" : "folder.badge.gearshape", chosen: !local, menu: true, action: onPickPlace)
                        .accessibilityLabel("Start in: \(draft.worktreeName ?? (fresh ? "New worktree" : "Local"))")
                }
                chip("Coordinate", symbol: "person.2", chosen: coordinating, menu: false) { onCoordinate(!coordinating) }
                    .accessibilityAddTraits(coordinating ? [.isSelected] : [])
                    .accessibilityHint("A coordinator starts and steers threads of its own")
            }
            .padding(.horizontal, 12)
        }
        .mask(HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 8)
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 24)
        })
        .padding(.bottom, 10)
    }

    private func chip(_ label: String, symbol: String, chosen: Bool, menu: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.caption.weight(.semibold))
                Text(label).lineLimit(1)
                if menu { Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.6) }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(chosen ? palette.accent : palette.inkDim)
            .padding(.horizontal, 11)
            .frame(height: 32)
            .background(chosen ? palette.accentChip : palette.surface, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// The one thing a phone is most often picked up for. Both answers are full-width, and one tap
/// decides: the chosen answer spins and both are disabled until the computer takes the card away.
struct ApprovalCard: View {
    var approval: MobileApproval
    var engine: String
    var refused: String?
    var onDecide: (Bool) -> Void
    @Environment(\.palette) private var palette
    @State private var decided: Bool?
    @State private var released: String?
    @State private var detailOpen: Bool

    init(approval: MobileApproval, engine: String, refused: String?, onDecide: @escaping (Bool) -> Void) {
        self.approval = approval
        self.engine = engine
        self.refused = refused
        self.onDecide = onDecide
        _detailOpen = State(initialValue: Format.glanceable(approval.detail))
        _released = State(initialValue: refused)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(palette.accent)
                    .frame(width: 34, height: 34)
                    .background(palette.accentChip, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(approval.from.map { "\($0) · Needs your approval" } ?? "Needs your approval")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.accent)
                    Text(approval.title).font(.headline).foregroundStyle(palette.ink)
                    Text(approval.description).font(.subheadline).foregroundStyle(palette.inkDim).fixedSize(horizontal: false, vertical: true)
                }
            }
            if !approval.detail.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.snappy) { detailOpen.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: ToolNames.family(engine: engine, approval.toolName).symbol).font(.caption.weight(.semibold))
                            Text(ToolNames.label(approval.toolName)).font(.footnote.weight(.semibold))
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold)).rotationEffect(.degrees(detailOpen ? 180 : 0))
                        }
                        .foregroundStyle(palette.muted)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(detailOpen ? "Expanded" : "Collapsed")
                    if detailOpen {
                        ScrollView {
                            Text(approval.detail)
                                .font(.footnote.monospaced())
                                .foregroundStyle(palette.codeInk)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12)
                                .padding(.bottom, 12)
                        }
                        .frame(maxHeight: 160)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .background(palette.codeSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            HStack(spacing: 10) {
                decision(allow: false)
                decision(allow: true)
            }
            .padding(.top, 2)
        }
        .padding(16)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(palette.accentLine, lineWidth: 1))
        .shadow(color: .black.opacity(palette.dark ? 0.35 : 0.08), radius: 16, y: 6)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .sensoryFeedback(trigger: decided) { _, next in
            next.map { $0 ? .success : .warning }
        }
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
                Text(chosen ? (allow ? "Allowing…" : "Denying…") : (allow ? "Allow Once" : "Deny"))
            }
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(allow ? palette.accentInk : palette.ink)
            .background(allow ? palette.accent : palette.raised, in: Capsule())
            .contentShape(Capsule())
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
            HStack(spacing: 10) {
                Image(systemName: "person.2.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.accent)
                    .frame(width: 30, height: 30)
                    .background(palette.accentChip, in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(members.isEmpty ? "Coordinating" : "Coordinating \(members.count) \(members.count == 1 ? "thread" : "threads")")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.ink)
                    (Text(waiting > 0 ? "\(waiting) \(waiting == 1 ? "needs" : "need") you" : "").foregroundStyle(palette.accent)
                        + Text(waiting > 0 && working > 0 ? " · " : "").foregroundStyle(palette.muted)
                        + Text(working > 0 ? "\(working) working" : members.isEmpty ? "No threads yet" : "").foregroundStyle(palette.muted))
                        .font(.footnote)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.quiet)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 4)
        .accessibilityHint("Shows the threads it coordinates")
    }
}
