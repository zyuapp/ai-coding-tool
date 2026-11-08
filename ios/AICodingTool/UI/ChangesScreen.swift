import SwiftUI

/// The thread's changes, read from the computer on demand and held only while this screen is up.
/// Nothing here moves the desktop's own review: the comparison is the phone's to pick.
struct ChangesScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var mode: Mode = .uncommitted
    @State private var summary: Summary = .reading
    @State private var open: Set<String> = []
    @State private var patches: [String: Patch] = [:]
    @State private var reads = 0

    enum Mode: Hashable { case uncommitted, branch }

    enum Summary: Equatable {
        case reading
        case read(DiffSummaryResult)
        case failed(String)
    }

    enum Patch: Equatable {
        case reading
        case rows([DiffRow])
        case tooLarge
        case failed(String)
    }

    private var thread: MobileThreadView? { model.view.thread }

    private var range: DiffRange {
        guard let thread else { return .uncommitted }
        return mode == .branch ? thread.branchRange : .uncommitted
    }

    var body: some View {
        Group {
            if let thread {
                content(thread)
            } else {
                Color.clear
            }
        }
        .screenBackground(palette)
        .notice(model)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("Changes").font(.headline).foregroundStyle(palette.ink)
                    if let title = thread?.title { Text(title).font(.caption).foregroundStyle(palette.muted).lineLimit(1) }
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                ConnectionMark(connection: model.state.connection)
                Button { refresh() } label: {
                    Image(systemName: "arrow.clockwise").symbolEffect(.rotate, isActive: summary == .reading)
                }
                .accessibilityLabel("Read the comparison again")
            }
        }
        .task(id: "\(thread?.id ?? ""):\(range.key):\(reads):\(model.live)") { await readSummary() }
    }

    private func content(_ thread: MobileThreadView) -> some View {
        let base: String = { if case .branches(let base, _) = thread.branchRange { return base } else { return "base" } }()
        return List {
            Picker("Comparison", selection: $mode) {
                Text("Uncommitted").tag(Mode.uncommitted)
                Text("Against \(base)").tag(Mode.branch)
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            if case .read(.available(_, let files, let additions, let deletions)) = summary, !files.isEmpty {
                HStack {
                    Text("\(files.count) \(files.count == 1 ? "file" : "files")").foregroundStyle(palette.muted)
                    Spacer()
                    Counts(additions: additions, deletions: deletions)
                }
                .font(.footnote)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            if let note = note {
                VStack(spacing: 10) {
                    Text(note).foregroundStyle(palette.muted).multilineTextAlignment(.center)
                    if model.live, isFailure { Button("Try again") { refresh() }.buttonStyle(.bordered) }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            ForEach(files) { file in
                FileSection(file: file, open: open.contains(file.path), patch: patches[patchKey(file)], onToggle: { toggle(file) }, onRetry: { read(file, force: true) })
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(palette.canvas)
                    .listRowSeparatorTint(palette.lineSoft)
            }
        }
        .listStyle(.plain)
        // Row separators keep the tint they were first drawn with, so a theme change redraws the list.
        .id(palette.id)
        .scrollContentBackground(.hidden)
    }

    private var files: [DiffFileSummary] {
        if case .read(.available(let read, let files, _, _)) = summary, read.key == range.key { return files }
        return []
    }

    private var isFailure: Bool {
        switch summary {
        case .failed, .read(.error): true
        default: false
        }
    }

    private var note: String? {
        guard model.live else { return "Waiting for the line to come back." }
        switch summary {
        case .reading: return "Reading the comparison…"
        case .failed(let message), .read(.error(let message)): return message
        case .read(.unknown): return "The checkout is no longer registered."
        case .read(.unavailable(let reason)): return "The checkout is \(reason)."
        case .read(.available(_, let files, _, _)): return files.isEmpty ? "Nothing has changed in this comparison." : nil
        }
    }

    private func patchKey(_ file: DiffFileSummary) -> String { "\(range.key)|\(file.path)|\(file.fingerprint)" }

    private func refresh() {
        patches = [:]
        reads += 1
    }

    private func readSummary() async {
        guard model.live, let thread else { return }
        summary = .reading
        open = []
        do {
            let result = try await model.connection.query(.diffSummary(taskId: thread.id, range: range))
            guard !Task.isCancelled else { return }
            summary = .read(try result.decode(DiffSummaryResult.self))
        } catch {
            guard !Task.isCancelled else { return }
            summary = .failed(error.localizedDescription)
        }
    }

    private func toggle(_ file: DiffFileSummary) {
        if open.remove(file.path) == nil {
            open.insert(file.path)
            read(file, force: false)
        }
    }

    /// A file is read when it is opened, and again only when its counts say it has changed underneath.
    private func read(_ file: DiffFileSummary, force: Bool) {
        guard !file.binary, let thread else { return }
        let key = patchKey(file)
        if !force, let held = patches[key] {
            if case .failed = held {} else { return }
        }
        patches[key] = .reading
        let range = range
        Task {
            do {
                let result = try await model.connection.query(.diffPatch(taskId: thread.id, range: range, path: file.path, previousPath: file.previousPath))
                switch try result.decode(DiffPatchResult.self) {
                case .available(let patch): patches[key] = .rows(Diff.rows(patch))
                case .tooLarge: patches[key] = .tooLarge
                case .error(let message): patches[key] = .failed(message)
                }
            } catch {
                patches[key] = .failed(error.localizedDescription)
            }
        }
    }
}

private struct Counts: View {
    var additions: Int
    var deletions: Int
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Text("+\(additions)").foregroundStyle(palette.success)
            Text("−\(deletions)").foregroundStyle(palette.danger)
        }
        .font(.footnote.monospacedDigit().weight(.medium))
    }
}

/// One file of the comparison: its row, and its patch once opened.
private struct FileSection: View {
    var file: DiffFileSummary
    var open: Bool
    var patch: ChangesScreen.Patch?
    var onToggle: () -> Void
    var onRetry: () -> Void
    @Environment(\.palette) private var palette
    @State private var whole = false

    /// A patch drawn whole would take a phone with it, so a long one is cut here until asked for.
    private static let rowCap = 1_500

    private var statusSymbol: String {
        switch file.status {
        case "added", "untracked": "doc.badge.plus"
        case "deleted": "doc.badge.minus"
        case "renamed": "doc.badge.arrow.up"
        default: "doc.badge.ellipsis"
        }
    }

    private var statusName: String {
        switch file.status {
        case "added", "untracked": "Added"
        case "deleted": "Deleted"
        case "renamed": "Renamed"
        default: "Modified"
        }
    }

    var body: some View {
        let (folder, name) = Diff.split(file.path)
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(palette.quiet).frame(width: 12)
                    Image(systemName: statusSymbol).font(.footnote).foregroundStyle(file.status == "deleted" ? palette.danger : file.status == "added" || file.status == "untracked" ? palette.success : palette.muted)
                    (Text(folder).foregroundStyle(palette.muted) + Text(name).foregroundStyle(palette.ink))
                        .font(.footnote)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 4)
                    if file.binary {
                        Text("binary").font(.caption).foregroundStyle(palette.muted)
                    } else {
                        Counts(additions: file.additions, deletions: file.deletions)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.path), \(statusName)")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            if open { patchView(for: patch) }
        }
    }

    @ViewBuilder private func patchView(for patch: ChangesScreen.Patch?) -> some View {
        if file.binary {
            note("Binary file")
        } else {
            switch patch {
            case nil, .reading?: note("Reading the file…")
            case .tooLarge?: note("This file's patch is too large to read here.")
            case .failed(let message)?:
                VStack(spacing: 8) {
                    Text(message).font(.footnote).foregroundStyle(palette.danger)
                    Button("Try again", action: onRetry).buttonStyle(.bordered).controlSize(.small)
                }
                .frame(maxWidth: .infinity)
                .padding(12)
            case .rows(let rows)?:
                let drawn = whole ? rows : Array(rows.prefix(Self.rowCap))
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(drawn) { row in DiffLine(row: row) }
                    }
                }
                .background(palette.sunken)
                if rows.count > drawn.count {
                    let hidden = rows.count - drawn.count
                    Button("Show \(hidden) more \(hidden == 1 ? "line" : "lines")") { whole = true }
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .padding(10)
                }
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(palette.muted).frame(maxWidth: .infinity).padding(12)
    }
}

private struct DiffLine: View {
    var row: DiffRow
    @Environment(\.palette) private var palette

    var body: some View {
        if row.kind == .hunk {
            Text(row.text)
                .font(.caption.monospaced())
                .foregroundStyle(palette.info)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .background(palette.hunkSurface)
        } else {
            HStack(spacing: 0) {
                gutter(row.oldLine)
                gutter(row.newLine)
                Text(row.kind == .add ? "+" : row.kind == .delete ? "−" : " ")
                    .foregroundStyle(row.kind == .add ? palette.success : row.kind == .delete ? palette.danger : palette.quiet)
                    .frame(width: 14)
                Text(row.text.isEmpty ? " " : row.text)
                    .foregroundStyle(palette.ink)
                    .fixedSize()
                    .padding(.trailing, 12)
            }
            .font(.caption.monospaced())
            .frame(minHeight: 20)
            .background(row.kind == .add ? palette.diffAddSurface : row.kind == .delete ? palette.diffDeleteSurface : Color.clear)
        }
    }

    private func gutter(_ line: Int?) -> some View {
        Text(line.map(String.init) ?? "")
            .foregroundStyle(palette.quiet)
            .frame(width: 38, alignment: .trailing)
            .padding(.trailing, 4)
            .background(row.kind == .add ? palette.diffAddGutter : row.kind == .delete ? palette.diffDeleteGutter : palette.sunken)
            .accessibilityHidden(true)
    }
}
