import SwiftUI

/// A sheet's frame: a title bar over the palette's menu ground. On iOS 26 the system's glass shows
/// through the bar, and a partial sheet floats inset as glass.
struct SheetFrame<Content: View, Actions: ToolbarContent>: View {
    var title: String
    @ViewBuilder var content: Content
    @ToolbarContentBuilder var actions: Actions
    @Environment(\.palette) private var palette

    var body: some View {
        NavigationStack {
            content
                .sheetPage(title, palette: palette)
                .toolbar { actions }
        }
        .presentationDragIndicator(.visible)
        .sheetPresentationGround(palette)
        .environment(\.palette, palette)
    }
}

extension View {
    /// A list laid out as a sheet's page, for the sheet's root and the pages pushed inside it.
    func sheetPage(_ title: String, palette: Palette) -> some View {
        listSectionSpacing(.compact)
            .contentMargins(.top, 8, for: .scrollContent)
            .scrollContentBackground(.hidden)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .sheetGround(palette)
    }

    @ViewBuilder fileprivate func sheetGround(_ palette: Palette) -> some View {
        if #available(iOS 26, *) {
            self
        } else {
            background(palette.menu.ignoresSafeArea()).toolbarBackground(palette.menu, for: .navigationBar)
        }
    }

    @ViewBuilder fileprivate func sheetPresentationGround(_ palette: Palette) -> some View {
        if #available(iOS 26, *) {
            self
        } else {
            presentationBackground(palette.menu)
        }
    }
}

/// The button that puts away a sheet whose choices take effect as they are made: the system's close glyph on iOS 26.
struct SheetClose: ToolbarContent {
    var action: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            if #available(iOS 26, *) {
                Button(role: .close, action: action).tint(nil)
            } else {
                Button("Done", action: action)
            }
        }
    }
}

/// Cancel and a confirming action, for a sheet whose change waits until it is confirmed.
struct SheetConfirm: ToolbarContent {
    var label: String
    var enabled: Bool
    var onCancel: () -> Void
    var onConfirm: () -> Void
    @Environment(\.palette) private var palette

    var body: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            if #available(iOS 26, *) {
                Button(role: .cancel, action: onCancel)
            } else {
                Button("Cancel", action: onCancel)
            }
        }
        ToolbarItem(placement: .confirmationAction) {
            if #available(iOS 26, *) {
                Button(label, role: .confirm, action: onConfirm).tint(palette.accent).disabled(!enabled)
            } else {
                Button(label, action: onConfirm).disabled(!enabled)
            }
        }
    }
}

/// A row's background in a sheet: the palette's raised ground, or on iOS 26 a wash of ink that takes the glass's own tone.
struct SheetRowGround: ViewModifier {
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.listRowBackground(palette.ink.opacity(palette.dark ? 0.06 : 0.05))
        } else {
            content.listRowBackground(palette.raised)
        }
    }
}

extension View {
    func sheetRow() -> some View { modifier(SheetRowGround()) }
}

extension View {
    /// A search field for lists long enough to need one.
    @ViewBuilder func searchableWhen(_ long: Bool, text: Binding<String>, prompt: String) -> some View {
        if long {
            searchable(text: text, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(prompt))
        } else {
            self
        }
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
        .buttonStyle(.target)
        .disabled(disabled && !selected)
        .opacity(disabled && !selected ? 0.5 : 1)
        .sheetRow()
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
                        .sheetRow()
                    }
                }
                if searching, matches.isEmpty {
                    VStack(spacing: 8) {
                        Text("No project matches “\(query.trimmingCharacters(in: .whitespaces))”").foregroundStyle(palette.muted)
                        Button("Clear search") { query = "" }.foregroundStyle(palette.accent)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
            .searchableWhen(projects.count > 8, text: $query, prompt: "Search projects")
        } actions: {
            SheetClose { dismiss() }
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
                        .sheetRow()
                } footer: {
                    Text("An empty name lets the next reply name the thread.").foregroundStyle(palette.muted)
                }
            }
        } actions: {
            SheetConfirm(label: "Save", enabled: changed, onCancel: { dismiss() }, onConfirm: save)
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
    func archiveConfirmation(_ ask: Binding<ArchiveAsk?>, restorable: Bool, onArchive: @escaping (ArchiveAsk) -> Void) -> some View {
        confirmationDialog(ask.wrappedValue.map { Format.archiveQuestion($0.title) } ?? "", isPresented: Binding(get: { ask.wrappedValue != nil }, set: { if !$0 { ask.wrappedValue = nil } }), titleVisibility: .visible, presenting: ask.wrappedValue) { asked in
            Button("Archive", role: .destructive) { onArchive(asked) }
        } message: { asked in
            Text(Format.archiveConsequence(running: asked.running, restorable: restorable))
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
                        OptionRow(label: choice.name, detail: choice.branch ?? "Detached", symbol: "folder.badge.gearshape", selected: false, disabled: locked) { move(.worktree(id: choice.id)) }
                    }
                    OptionRow(label: "New worktree", detail: "A checkout of its own, cut from the project", symbol: "plus", selected: false, disabled: locked) { move(.new) }
                } footer: {
                    Text(locked ? "Wait for the run to finish before moving the thread." : "Existing file changes stay in the old checkout.")
                        .font(.footnote)
                        .foregroundStyle(palette.muted)
                }
            }
        } actions: {
            SheetClose { dismiss() }
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
            SheetClose { dismiss() }
        }
        .presentationDetents([.medium, .large])
    }

    private func pick(_ action: () -> Void) {
        dismiss()
        action()
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
                    if member.openable {
                        NavigationLink {
                            MemberTranscript(model: model, member: member) {
                                dismiss()
                                model.openThread(member.id, title: member.title, project: member.computer ?? project)
                            }
                                .onAppear { withAnimation(.glide) { detent = .large } }
                        } label: {
                            row(member)
                        }
                        .sheetRow()
                    } else {
                        row(member)
                            .sheetRow()
                            .accessibilityHint(member.online == false ? "\(member.computer ?? "Its computer") is offline" : "Open it on \(member.computer ?? "that computer")")
                    }
                }
            }
        } actions: {
            SheetClose { dismiss() }
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
                Text([member.online == false ? "Offline" : Format.statusLabel(member.status) ?? "Idle", member.computer].compactMap { $0 }.joined(separator: " · "))
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
                VStack(alignment: .leading, spacing: 18) {
                    if let read {
                        if read.omitted > 0 {
                            Text("\(read.omitted) earlier \(read.omitted == 1 ? "message is" : "messages are") only on the computer.").font(.footnote).foregroundStyle(palette.muted)
                        }
                        let blocks = Format.transcriptBlocks(read.messages, omitted: read.omitted)
                        let latest = Format.latestAnswer(blocks)
                        ForEach(blocks) { block in
                            switch block {
                            case .message(let key, let message, let answer): MessageView(message: message, answer: answer && key == latest)
                            // The computer names each call's family, so no engine is needed to read it.
                            case .tools(_, let calls): ToolRunView(engine: "", calls: calls)
                            }
                        }
                        if let tail = read.streamingTail { MarkdownView(text: tail) }
                        if read.status == "running" { WorkingLine() }
                    } else {
                        Text(problem ?? "Reading the thread…").foregroundStyle(palette.muted).frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Space.page)
                .padding(.vertical, Space.l)
            }
            .environment(\.pictureSource, PictureSource(taskId: member.id, store: model.pictures, connection: model.connection))
            .defaultScrollAnchor(.top, for: .alignment)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
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
        }
        .bottomBar {
            Button(action: onOpen) {
                ActionLabel(title: "Open to Reply", symbol: "arrow.up.forward")
            }
            .buttonStyle(.press)
            .padding(.horizontal, Space.l)
            .padding(.bottom, 8)
            .accessibilityHint("Opens this thread to talk to it")
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
                        .sheetRow()
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
                            .buttonStyle(.target)
                            .sheetRow()
                        }
                    } header: {
                        SectionLabel("Folders")
                    }
                }
            }
        } actions: {
            SheetConfirm(label: "Add", enabled: !(root.isEmpty || root == "~" || root == "~/"), onCancel: { dismiss() }, onConfirm: add)
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
