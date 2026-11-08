import SwiftUI

/// A sheet's frame: a title bar with Done, over the palette's menu ground.
struct SheetFrame<Content: View, Actions: ToolbarContent>: View {
    var title: String
    @ViewBuilder var content: Content
    @ToolbarContentBuilder var actions: Actions
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            content
                .listSectionSpacing(.compact)
                .contentMargins(.top, 8, for: .scrollContent)
                .scrollContentBackground(.hidden)
                .background(palette.menu.ignoresSafeArea())
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(palette.menu, for: .navigationBar)
                .toolbar { actions }
        }
        .presentationBackground(palette.menu)
        .environment(\.palette, palette)
    }
}

/// A sheet section's caption, quieter than the sheet's own title.
struct SectionLabel: View {
    var text: String
    @Environment(\.palette) private var palette

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(palette.muted).textCase(nil)
    }
}

/// One choice in a sheet: a label over its description, checked when chosen.
struct OptionRow: View {
    var label: String
    var detail: String?
    var symbol: String?
    var selected: Bool
    var disabled = false
    var action: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.body.weight(.medium))
                        .frame(width: 26)
                        .foregroundStyle(selected ? palette.accent : palette.muted)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(palette.ink)
                    if let detail, !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(palette.muted) }
                }
                Spacer()
                if selected { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(palette.accent) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled && !selected)
        .opacity(disabled && !selected ? 0.5 : 1)
        .listRowBackground(palette.raised)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// A project found by typing its name, or the one choice that is no project at all.
struct ProjectSheet: View {
    var projects: [MobileProjectGroup]
    var selected: String?
    var none: String
    var label: String
    /// Present where a new project can be started from, which opens the folder browser.
    var onAddProject: (() -> Void)? = nil
    var onSelect: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""

    var body: some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let matches = Matching.ranked(projects, query: query) { $0.name }
        SheetFrame(title: "Project") {
            List {
                Section {
                    if !searching {
                        OptionRow(label: none, symbol: "square.stack", selected: selected == nil) { choose(nil) }
                    }
                    ForEach(matches, id: \.projectId) { project in
                        OptionRow(label: project.name, symbol: "folder", selected: project.projectId == selected) { choose(project.projectId) }
                    }
                } header: {
                    SectionLabel(label)
                }
                if let onAddProject {
                    Section {
                        Button {
                            dismiss()
                            onAddProject()
                        } label: {
                            Label("Add project…", systemImage: "folder.badge.plus").foregroundStyle(palette.accent)
                        }
                        .listRowBackground(palette.raised)
                    }
                }
                if searching, matches.isEmpty {
                    VStack(spacing: 8) {
                        Text("No project matches “\(query.trimmingCharacters(in: .whitespaces))”").foregroundStyle(palette.muted)
                        Button("Clear search") { query = "" }
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search projects")
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }

    private func choose(_ projectId: String?) {
        dismiss()
        onSelect(projectId)
    }
}

struct RenameSheet: View {
    var title: String
    var onRename: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var draft: String
    @FocusState private var focused: Bool

    init(title: String, onRename: @escaping (String) -> Void) {
        self.title = title
        self.onRename = onRename
        _draft = State(initialValue: title)
    }

    private var changed: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines) != title }

    var body: some View {
        SheetFrame(title: "Rename") {
            List {
                Section {
                    TextField("Thread title", text: $draft)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { if changed { save() } }
                        .onChange(of: draft) { _, next in if next.count > 1_000 { draft = String(next.prefix(1_000)) } }
                        .listRowBackground(palette.raised)
                } footer: {
                    Text("An empty name lets the next reply name the thread.").foregroundStyle(palette.muted)
                }
            }
        } actions: {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(!changed) }
        }
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }

    private func save() {
        onRename(draft.trimmingCharacters(in: .whitespacesAndNewlines))
        dismiss()
    }
}

/// A thread the user has asked to archive, waiting on their confirmation.
struct ArchiveAsk: Identifiable, Equatable {
    var id: String
    var title: String
    var running: Bool
}

extension View {
    /// The question asked before the user archives a thread, as the desktop asks it.
    func archiveConfirmation(_ ask: Binding<ArchiveAsk?>, onArchive: @escaping (ArchiveAsk) -> Void) -> some View {
        confirmationDialog(ask.wrappedValue.map { Format.archiveQuestion($0.title) } ?? "", isPresented: Binding(get: { ask.wrappedValue != nil }, set: { if !$0 { ask.wrappedValue = nil } }), titleVisibility: .visible, presenting: ask.wrappedValue) { asked in
            Button("Archive", role: .destructive) { onArchive(asked) }
        } message: { asked in
            Text(Format.archiveConsequence(running: asked.running))
        }
    }
}

/// Where the thread works, and where it could. Moving leaves the files where they are.
struct LocationSheet: View {
    var thread: MobileThreadView
    var onMove: (WorktreeDestination) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        let locked = !thread.canMove
        SheetFrame(title: "Location") {
            List {
                Section {
                    OptionRow(label: thread.projectName ?? "Project", detail: "The project's own checkout", symbol: "folder", selected: thread.location == .local, disabled: locked) { move(.local) }
                    if case .worktree(let name, let threads) = thread.location {
                        OptionRow(label: name, detail: threads == 1 ? "Removed once this thread leaves" : "\(threads) threads work here", symbol: "folder.badge.gearshape", selected: true) {}
                    }
                    ForEach(thread.worktrees) { choice in
                        OptionRow(label: choice.name, detail: choice.branch ?? "Detached", symbol: "folder.badge.gearshape", selected: false, disabled: locked) { move(.worktree(choice.id)) }
                    }
                    OptionRow(label: "New worktree", detail: "A checkout of its own, cut from the project", symbol: "plus", selected: false, disabled: locked) { move(.new) }
                } footer: {
                    Text(locked ? "Wait for the run to finish before moving the thread." : "Existing file changes stay in the old checkout.")
                        .font(.footnote)
                        .foregroundStyle(palette.muted)
                }
            }
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }

    private func move(_ destination: WorktreeDestination) {
        if destination == .local, thread.location == .local { return }
        dismiss()
        onMove(destination)
    }
}

/// Where a new thread starts: the project's checkout, one of its own, or one the project already has.
struct StartInSheet: View {
    var draft: MobileDraftView
    var onSetWorktree: (Bool) -> Void
    var onStartIn: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let fresh = draft.worktree && draft.worktreeName == nil
        let local = !draft.worktree && draft.worktreeName == nil
        SheetFrame(title: "Start in") {
            List {
                Section {
                    OptionRow(label: draft.projectName ?? "Project", detail: "The project's own checkout", symbol: "folder", selected: local) { pick { onSetWorktree(false) } }
                    if let name = draft.worktreeName, !draft.worktrees.contains(where: { $0.name == name }) {
                        OptionRow(label: name, symbol: "folder.badge.gearshape", selected: true) {}
                    }
                    ForEach(draft.worktrees) { choice in
                        OptionRow(label: choice.name, detail: choice.branch ?? "Detached", symbol: "folder.badge.gearshape", selected: choice.name == draft.worktreeName) {
                            if choice.name != draft.worktreeName { pick { onStartIn(choice.id) } }
                        }
                    }
                    if draft.canWorktree {
                        OptionRow(label: "New worktree", detail: "A checkout of its own, cut from the project", symbol: "plus", selected: fresh) { pick { onSetWorktree(true) } }
                    }
                }
            }
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }

    private func pick(_ action: () -> Void) {
        dismiss()
        action()
    }
}

/// Mode, model, effort and fast mode. A tapped choice shows at once and is let go of when the
/// computer's settings agree; one a live line leaves unechoed reverts and is marked refused.
struct ThreadSettingsSheet: View {
    var settings: MobileThreadSettings
    var catalog: EngineCatalog
    var live: Bool
    /// Set for a thread that exists, whose engine is settled; a draft may still pick any.
    var locked: Bool
    var onNewWith: ((String) -> Void)?
    var onPolicy: (String) -> Void
    var onModel: (String, String) -> Void
    var onFastMode: (Bool) -> Void
    var onEffort: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var pending = Pending()
    @State private var refused: Set<String> = []
    @State private var timer: Task<Void, Never>?

    struct Pending: Equatable {
        var policy: String?
        var engine: String?
        var model: String?
        var effort: String?
        var fastMode: Bool?

        var isEmpty: Bool { self == Pending() }

        func echoed(by settings: MobileThreadSettings) -> Bool {
            (policy == nil || policy == settings.policy) && (engine == nil || engine == settings.engine) && (model == nil || model == settings.model) && (effort == nil || effort == settings.effort) && (fastMode == nil || fastMode == settings.fastMode)
        }

        func unechoed(by settings: MobileThreadSettings) -> Set<String> {
            var keys: Set<String> = []
            if let policy, policy != settings.policy { keys.insert("policy") }
            if let engine, engine != settings.engine { keys.insert("engine") }
            if let model, model != settings.model { keys.insert("model") }
            if let effort, effort != settings.effort { keys.insert("effort") }
            if let fastMode, fastMode != settings.fastMode { keys.insert("fastMode") }
            return keys
        }
    }

    private var shown: MobileThreadSettings {
        var next = settings
        if let policy = pending.policy { next.policy = policy }
        if let engine = pending.engine { next.engine = engine }
        if let model = pending.model { next.model = model }
        if let effort = pending.effort { next.effort = effort }
        if let fastMode = pending.fastMode { next.fastMode = fastMode }
        return next
    }

    var body: some View {
        let current = shown
        let known = catalog.knows(current.engine)
        let coordinating = current.coordinating == true
        let headings = catalog.library(engine: current.engine, locked: locked)
        let offering = Set(headings.filter { !$0.models.isEmpty }.map(\.engine))
        let others = onNewWith == nil ? [] : headings.filter { $0.locked && $0.first && offering.contains($0.engine) }
        let efforts = known && current.model != nil ? catalog.efforts(current.engine, model: current.model!, coordinating: coordinating) : []
        SheetFrame(title: "Settings") {
            List {
                if known {
                    Section {
                        ForEach(catalog.policies(current.engine), id: \.id) { policy in
                            OptionRow(label: policy.label, detail: policy.description, symbol: Self.policySymbol(policy.id), selected: policy.id == current.policy) {
                                choose { $0.policy = policy.id }
                                onPolicy(policy.id)
                            }
                        }
                        refusedLine("policy")
                    } header: {
                        SectionLabel("Mode")
                    }
                }
                // Each engine or provider is a card of its own under its name, so every card keeps its rounded corners.
                let offered = headings.filter { !$0.locked && !$0.models.isEmpty }
                ForEach(Array(offered.enumerated()), id: \.element.key) { index, heading in
                    Section {
                        ForEach(heading.models, id: \.id) { spec in
                            OptionRow(label: spec.label, detail: spec.description, selected: heading.engine == current.engine && spec.id == current.model) {
                                choose { $0.engine = heading.engine; $0.model = spec.id }
                                onModel(heading.engine, spec.id)
                            }
                        }
                        if index == offered.count - 1, refused.contains("model") || refused.contains("engine") { refusedText }
                    } header: {
                        SectionLabel("\(heading.label) models")
                    }
                }
                if !others.isEmpty {
                    Section(header: SectionLabel("Other engines")) {
                        ForEach(others, id: \.engine) { heading in
                            Button {
                                dismiss()
                                onNewWith?(heading.engine)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "square.and.pencil").frame(width: 24).foregroundStyle(palette.muted)
                                    Text("New thread with \(catalog.engineLabel(heading.engine))").foregroundStyle(palette.ink)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.quiet)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(palette.raised)
                        }
                    }
                }
                if known, let model = current.model, !efforts.isEmpty {
                    let chosen = catalog.effortForModel(current.engine, model: model, effort: current.effort, coordinating: coordinating)
                    Section {
                        ForEach(efforts, id: \.id) { effort in
                            OptionRow(label: effort.label, detail: effort.description, selected: effort.id == chosen) {
                                choose { $0.effort = effort.id }
                                onEffort(current.engine, effort.id)
                            }
                        }
                        refusedLine("effort")
                    } header: {
                        SectionLabel("Effort")
                    }
                }
                if catalog.fastMode(current.engine) {
                    Section {
                        Toggle(isOn: Binding(get: { current.fastMode == true }, set: { value in
                            choose { $0.fastMode = value }
                            onFastMode(value)
                        })) {
                            Label("Fast mode", systemImage: "bolt").foregroundStyle(palette.ink)
                        }
                        .listRowBackground(palette.raised)
                        refusedLine("fastMode")
                    }
                }
            }
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: settings) { _, _ in reconsider() }
        .onChange(of: live) { _, _ in reconsider() }
    }

    static func policySymbol(_ policy: String) -> String {
        switch policy {
        case "confirm": "hand.raised"
        case "allow-edits": "pencil.line"
        case "autonomous": "wand.and.sparkles"
        case "bypass": "bolt"
        default: "circle.dashed"
        }
    }

    @ViewBuilder private func refusedLine(_ key: String) -> some View {
        if refused.contains(key) { refusedText }
    }

    private var refusedText: some View {
        Text("Couldn't change. Try again.").font(.footnote).foregroundStyle(palette.danger).listRowBackground(palette.menu)
    }

    private func choose(_ change: (inout Pending) -> Void) {
        refused = []
        change(&pending)
        reconsider()
    }

    private func reconsider() {
        timer?.cancel()
        guard !pending.isEmpty else { return }
        if pending.echoed(by: settings) {
            pending = Pending()
            return
        }
        guard live else { return }
        let asked = pending
        timer = Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, pending == asked else { return }
            refused = asked.unechoed(by: settings)
            pending = Pending()
        }
    }
}

/// The threads working under a coordinator. One on this computer opens to its conversation, read
/// as the coordinator's tab shows it; one another computer holds is only listed.
struct MembersSheet: View {
    var model: PhoneModel
    var members: [MobileMember]
    var project: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var detent: PresentationDetent
    private let fitted: PresentationDetent

    init(model: PhoneModel, members: [MobileMember], project: String?) {
        self.model = model
        self.members = members
        self.project = project
        fitted = .height(CGFloat(100 + max(1, members.count) * 62))
        _detent = State(initialValue: fitted)
    }

    var body: some View {
        SheetFrame(title: "Coordinated Threads") {
            List {
                if members.isEmpty {
                    Text("No threads yet. Ask it to start some.").foregroundStyle(palette.muted).listRowBackground(Color.clear)
                }
                ForEach(members) { member in
                    if member.computer == nil {
                        NavigationLink {
                            MemberTranscript(model: model, member: member) {
                                dismiss()
                                model.openThread(member.id, title: member.title, project: project)
                            }
                                .onAppear { withAnimation(.snappy) { detent = .large } }
                        } label: {
                            row(member)
                        }
                        .listRowBackground(palette.raised)
                    } else {
                        row(member)
                            .listRowBackground(palette.raised)
                            .accessibilityHint("Open it on \(member.computer ?? "that computer")")
                    }
                }
            }
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([fitted, .large], selection: $detent)
        .onChange(of: fitted) { _, next in
            if detent != .large { detent = next }
        }
    }

    private func row(_ member: MobileMember) -> some View {
        HStack(spacing: 12) {
            MemberMark(status: member.status).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(member.title).foregroundStyle(palette.ink).lineLimit(1)
                Text([Format.statusLabel(member.status) ?? "Idle", member.computer].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(member.status == "awaiting-approval" ? palette.accent : palette.muted)
            }
        }
    }
}

/// One member's conversation, read from the computer and read again every few seconds while it is on screen.
struct MemberTranscript: View {
    var model: PhoneModel
    var member: MobileMember
    var onOpen: () -> Void
    @Environment(\.palette) private var palette
    @State private var read: MobileThreadRead?
    @State private var problem: String?

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let read {
                        if read.omitted > 0 {
                            Text("\(read.omitted) earlier \(read.omitted == 1 ? "message is" : "messages are") only on the computer.").font(.footnote).foregroundStyle(palette.muted)
                        }
                        let blocks = Format.transcriptBlocks(read.messages)
                        let latest = Format.latestAnswer(blocks)
                        ForEach(blocks) { block in
                            switch block {
                            case .message(let key, let message, let answer): MessageView(message: message, answer: answer && key == latest)
                            // The computer names each call's family, so no engine is needed to read it.
                            case .tools(_, let calls): ToolRunView(engine: "", calls: calls)
                            }
                        }
                        if let tail = read.streamingTail { MarkdownView(text: tail) }
                        if read.status == "running" { ThinkingDots().accessibilityLabel("Working") }
                    } else {
                        Text(problem ?? "Reading the thread…").foregroundStyle(palette.muted).frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(16)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: read?.messages.count) { _, _ in reader.scrollTo("end", anchor: .bottom) }
        }
        .background(palette.menu)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(read?.title ?? member.title).font(.headline).foregroundStyle(palette.ink).lineLimit(1)
                    Text(Format.statusLabel(read?.status ?? member.status) ?? "Idle").font(.caption).foregroundStyle(palette.muted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Open", action: onOpen)
                    .accessibilityHint("Opens this thread to talk to it")
            }
        }
        .task {
            while !Task.isCancelled {
                do {
                    read = try await model.connection.query(.thread(taskId: member.id)).decode(MobileThreadRead.self)
                    problem = nil
                } catch {
                    problem = error.localizedDescription
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

/// A member's state at a glance: a ring while it waits on the user, a spinner while it works.
struct MemberMark: View {
    var status: String
    @Environment(\.palette) private var palette

    var body: some View {
        switch status {
        case "awaiting-approval": StatusDot(kind: .needsYou)
        case "running": RunningMark()
        default: Circle().fill(palette.quiet).frame(width: 8, height: 8)
        }
    }
}

/// A folder on the computer opened as a project, found by typing its path as the desktop's own add
/// dialog does: each keystroke lists the folders that path could go on to.
struct AddProjectSheet: View {
    var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var path = "~/"
    @State private var folders: [String] = []
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var root: String { path.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        SheetFrame(title: "Add project") {
            List {
                Section {
                    TextField("Folder on your computer", text: $path)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.done)
                        .focused($focused)
                        .onSubmit(add)
                        .listRowBackground(palette.raised)
                        .accessibilityLabel("Folder path")
                } footer: {
                    Text(problem ?? "A thread starts in it once it is added.").foregroundStyle(problem == nil ? palette.muted : palette.danger)
                }
                if !folders.isEmpty {
                    Section {
                        ForEach(folders, id: \.self) { folder in
                            Button { path = folder.hasSuffix("/") ? folder : folder + "/" } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "folder").foregroundStyle(palette.muted)
                                    Text(Self.shown(folder)).font(.callout.monospaced()).foregroundStyle(palette.ink).lineLimit(1).truncationMode(.head)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.quiet)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(palette.raised)
                        }
                    } header: {
                        SectionLabel("Folders")
                    }
                }
            }
        } actions: {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) { Button("Add", action: add).disabled(root.isEmpty || root == "~" || root == "~/") }
        }
        .presentationDetents([.large])
        .onAppear { focused = true }
        .task(id: path) { await list() }
    }

    /// The folder's own name last, which is what tells two deep paths apart.
    static func shown(_ folder: String) -> String {
        folder.hasSuffix("/") ? String(folder.dropLast()) : folder
    }

    private func list() async {
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled, !root.isEmpty else { return }
        do {
            let answer = try await model.connection.query(.directories(prefix: root))
            guard !Task.isCancelled else { return }
            folders = (try? answer.decode([String].self)) ?? []
            problem = nil
        } catch {
            guard !Task.isCancelled else { return }
            folders = []
            problem = error.localizedDescription
        }
    }

    private func add() {
        let folder = root.hasSuffix("/") && root.count > 1 ? String(root.dropLast()) : root
        guard !folder.isEmpty, folder != "~" else { return }
        model.send(.addProject(folder))
        dismiss()
    }
}
