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
                    Image(systemName: symbol).frame(width: 24).foregroundStyle(palette.muted)
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
    var onSelect: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var query = ""

    var body: some View {
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        let matches = Matching.ranked(projects, query: query) { $0.name }
        SheetFrame(title: "Project") {
            List {
                Section(label) {
                    if !searching {
                        OptionRow(label: none, selected: selected == nil) { choose(nil) }
                    }
                    ForEach(matches, id: \.projectId) { project in
                        OptionRow(label: project.name, selected: project.projectId == selected) { choose(project.projectId) }
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

/// The question asked before the user archives a thread, as the desktop asks it.
struct ArchiveSheet: View {
    var title: String
    var running: Bool
    var onArchive: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        SheetFrame(title: "Archive thread") {
            List {
                Section {
                    Button(role: .destructive) {
                        dismiss()
                        onArchive()
                    } label: {
                        Label("Archive", systemImage: "archivebox").foregroundStyle(palette.danger)
                    }
                    .listRowBackground(palette.raised)
                } header: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(Format.archiveQuestion(title)).font(.headline).foregroundStyle(palette.ink)
                        Text(Format.archiveConsequence(running: running)).font(.subheadline).foregroundStyle(palette.inkDim)
                    }
                    .textCase(nil)
                    .padding(.bottom, 8)
                }
            }
        } actions: {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        }
        .presentationDetents([.height(300), .medium])
    }
}

/// What a thread can do beyond talking: what the desktop's header offers, with nothing the phone cannot see through.
struct ThreadMenuSheet: View {
    var thread: MobileThreadView
    var onChanges: () -> Void
    var onLocation: () -> Void
    var onNewHere: () -> Void
    var onFork: (Bool) -> Void
    var onRename: () -> Void
    var onArchive: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    var body: some View {
        let inProject = thread.projectId != nil
        let working = thread.location == .creating || thread.location == .releasing
        let inWorktree: Bool = { if case .worktree = thread.location { return true } else { return false } }()
        SheetFrame(title: thread.title) {
            List {
                Section {
                    row("Changes", detail: thread.reviewable ? Format.changesLabel(thread.changes) ?? "Review this thread's edits" : "No checkout to review", symbol: "arrow.left.arrow.right", disabled: !thread.reviewable, opens: true, action: onChanges)
                    row("Location", detail: inProject ? Format.locationLabel(thread.location) : "Not in a project", symbol: inWorktree ? "folder.badge.gearshape" : "folder", disabled: !inProject || working, opens: true, action: onLocation)
                }
                Section {
                    row(inWorktree ? "New thread here" : "New thread in project", detail: !inProject ? "Not in a project" : working ? Format.locationLabel(thread.location) : nil, symbol: "square.and.pencil", disabled: !inProject || working, action: onNewHere)
                    row("Fork thread", detail: "Copy the conversation into a new thread", symbol: "arrow.triangle.branch") { onFork(false) }
                    if inProject {
                        row("Fork in a worktree", detail: working ? Format.locationLabel(thread.location) : "The copy gets a checkout of its own", symbol: "folder.badge.plus", disabled: working) { onFork(true) }
                    }
                }
                Section {
                    row("Rename…", symbol: "pencil.line", action: onRename)
                    row("Archive…", symbol: "archivebox", danger: true, action: onArchive)
                }
            }
        } actions: {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ label: String, detail: String? = nil, symbol: String, disabled: Bool = false, opens: Bool = false, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            dismiss()
            action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).frame(width: 24).foregroundStyle(danger ? palette.danger : palette.muted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(danger ? palette.danger : palette.ink)
                    if let detail { Text(detail).font(.footnote).foregroundStyle(palette.muted) }
                }
                Spacer()
                if opens { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.quiet) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .listRowBackground(palette.raised)
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
                } header: {
                    Text(locked ? "Wait for the run to finish before moving the thread." : "Existing file changes stay in the old checkout.")
                        .textCase(nil)
                        .foregroundStyle(palette.inkDim)
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
                    Section("Mode") {
                        ForEach(catalog.policies(current.engine), id: \.id) { policy in
                            OptionRow(label: policy.label, detail: policy.description, selected: policy.id == current.policy) {
                                choose { $0.policy = policy.id }
                                onPolicy(policy.id)
                            }
                        }
                        refusedLine("policy")
                    }
                }
                Section("Model") {
                    ForEach(headings.filter { !$0.locked && !$0.models.isEmpty }, id: \.key) { heading in
                        subheading(heading.label)
                        ForEach(heading.models, id: \.id) { spec in
                            OptionRow(label: spec.label, detail: spec.description, selected: heading.engine == current.engine && spec.id == current.model) {
                                choose { $0.engine = heading.engine; $0.model = spec.id }
                                onModel(heading.engine, spec.id)
                            }
                        }
                    }
                    if refused.contains("model") || refused.contains("engine") { refusedText }
                    ForEach(others, id: \.engine) { heading in
                        subheading(catalog.engineLabel(heading.engine))
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
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(palette.raised)
                    }
                }
                if known, let model = current.model, !efforts.isEmpty {
                    let chosen = catalog.effortForModel(current.engine, model: model, effort: current.effort, coordinating: coordinating)
                    Section("Effort") {
                        ForEach(efforts, id: \.id) { effort in
                            OptionRow(label: effort.label, detail: effort.description, selected: effort.id == chosen) {
                                choose { $0.effort = effort.id }
                                onEffort(current.engine, effort.id)
                            }
                        }
                        refusedLine("effort")
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

    private func subheading(_ label: String) -> some View {
        Text(label)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(palette.muted)
            .listRowBackground(palette.menu)
            .listRowSeparator(.hidden)
            .accessibilityAddTraits(.isHeader)
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
