import SwiftUI

/// The thread's changes, read from the computer on demand and held only while this screen is up.
/// Nothing here moves the desktop's own review: the comparison is the phone's to pick.
struct ChangesScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @Environment(\.displayScale) private var displayScale
    @State private var mode: Mode = .uncommitted
    @State private var summary: Summary = .reading
    @State private var open: Set<String> = []
    @State private var patches: [String: Patch] = [:]
    @State private var reads = 0
    @AppStorage(WrapLines.key) private var wrap = true

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
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .barSubtitle([thread?.title, model.state.connection != .live ? model.state.connection.label : nil].compactMap { $0 }.joined(separator: " · "))
        .toolbar {
            if #unavailable(iOS 26) {
                LegacyBarTitle(title: "Changes", subtitle: thread?.title)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle(isOn: Binding(get: { wrap }, set: { value in withAnimation(.glide) { wrap = value } })) {
                        Label("Wrap Lines", systemImage: "text.word.spacing")
                    }
                    Button { refresh() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                } label: {
                    Label("View Options", systemImage: "ellipsis")
                }
                .tint(palette.ink)
            }
        }
        .task(id: "\(thread?.id ?? ""):\(range.key):\(reads):\(model.live)") { await readSummary() }
    }

    private func content(_ thread: MobileThreadView) -> some View {
        let base: String = { if case .branches(let base, _) = thread.branchRange { return base } else { return "base" } }()
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Picker("Comparison", selection: $mode) {
                    Text("Uncommitted").tag(Mode.uncommitted)
                    Text("Against \(base)").tag(Mode.branch)
                }
                .pickerStyle(.segmented)
                .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                if case .read(.available(_, let files, let additions, let deletions)) = summary, !files.isEmpty {
                    HStack {
                        Text("\(files.count) \(files.count == 1 ? "file" : "files") changed").font(.footnote.weight(.semibold)).foregroundStyle(palette.muted)
                        Spacer()
                        Counts(additions: additions, deletions: deletions)
                    }
                    .padding(EdgeInsets(top: 12, leading: 16, bottom: 8, trailing: 16))
                }
                if let note = note {
                    Group {
                        if model.live, summary == .reading {
                            HStack(spacing: Space.s) {
                                Spinner(size: 13, color: palette.muted)
                                Text("Reading the comparison").font(.subheadline).foregroundStyle(palette.muted).shimmer(palette.ink)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 40)
                        } else {
                            ContentUnavailableView {
                                Label(noteTitle, systemImage: isFailure ? "exclamationmark.triangle" : model.live ? "plus.forwardslash.minus" : "icloud.slash")
                            } description: {
                                Text(note)
                            } actions: {
                                if model.live, isFailure { Button("Try Again") { refresh() }.foregroundStyle(palette.accent) }
                            }
                        }
                    }
                    .padding(.top, 24)
                }
                ForEach(files) { file in
                    FileSection(file: file, open: open.contains(file.path), patch: patches[patchKey(file)], onToggle: { toggle(file) }, onRetry: { read(file, force: true) })
                        .background(palette.canvas)
                    if file.id != files.last?.id {
                        palette.lineSoft.frame(height: 1 / displayScale).padding(.leading, 46)
                    }
                }
            }
        }
        .refreshable {
            patches = [:]
            await readSummary()
        }
        .hardTopEdge()
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

    private var noteTitle: String {
        if !model.live { return "Offline" }
        if isFailure { return "Couldn't Read Changes" }
        return "No Changes"
    }

    private var note: String? {
        guard model.live else { return "Waiting for the line to come back." }
        switch summary {
        case .reading: return "Reading the comparison…"
        case .failed(let message), .read(.error(let message)): return message
        case .read(.unknown): return "The checkout is no longer registered."
        case .read(.unavailable(let reason)): return "The checkout is \(reason)."
        case .read(.available(_, let files, _, _)): return files.isEmpty ? "Nothing differs in this comparison." : nil
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

struct Counts: View {
    var additions: Int
    var deletions: Int
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            if additions > 0 || deletions == 0 { Text("+\(additions)").foregroundStyle(palette.success) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(palette.danger) }
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
    @State private var viewport: CGFloat = 0
    @AppStorage(WrapLines.key) private var wrap = true

    /// A patch drawn whole would take a phone with it, so a long one is cut here until asked for.
    private static let rowCap = 1_500

    private var statusLetter: String {
        switch file.status {
        case "added", "untracked": "A"
        case "deleted": "D"
        case "renamed": "R"
        default: "M"
        }
    }

    private var statusColor: Color {
        switch file.status {
        case "added", "untracked": palette.success
        case "deleted": palette.danger
        case "renamed": palette.info
        default: palette.warning
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
                    Text(statusLetter)
                        .font(.caption2.weight(.heavy).monospaced())
                        .foregroundStyle(statusColor)
                        .frame(width: 20, height: 20)
                        .background(statusColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name).font(.subheadline.weight(.medium)).foregroundStyle(palette.ink).lineLimit(1)
                        if !folder.isEmpty {
                            Text(folder).font(.caption).foregroundStyle(palette.muted).lineLimit(1).truncationMode(.head)
                        }
                    }
                    Spacer(minLength: 4)
                    if file.binary {
                        Text("Binary").font(.caption.weight(.medium)).foregroundStyle(palette.muted)
                    } else {
                        Counts(additions: file.additions, deletions: file.deletions)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(palette.quiet)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.target)
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
                let measure = DiffLine.Measure(rows: drawn)
                Group {
                    if wrap {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(drawn) { row in DiffLine(row: row, gutter: measure.gutter, viewport: viewport, wrap: true) }
                        }
                    } else {
                        ScrollView(.horizontal) {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(drawn) { row in DiffLine(row: row, gutter: measure.gutter, viewport: viewport, wrap: false) }
                            }
                            .frame(width: max(viewport, measure.width + 30), alignment: .leading)
                        }
                    }
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { viewport = $0 }
                .background(palette.sunken)
                if rows.count > drawn.count {
                    let hidden = rows.count - drawn.count
                    Button("Show \(hidden) more \(hidden == 1 ? "line" : "lines")") { whole = true }
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(palette.accent)
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
    var gutter: CGFloat
    var viewport: CGFloat
    var wrap: Bool
    @Environment(\.palette) private var palette

    /// The widths a patch draws at: each line-number column fits its longest number, and the rows run as wide as the longest line.
    struct Measure {
        var gutter: CGFloat
        var width: CGFloat

        init(rows: [DiffRow]) {
            let font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular)
            let advance = ("0" as NSString).size(withAttributes: [.font: font]).width
            var widest: CGFloat = 0
            var highest = 0
            for row in rows where row.kind != .hunk {
                widest = max(widest, (row.text as NSString).size(withAttributes: [.font: font]).width)
                highest = max(highest, row.oldLine ?? 0, row.newLine ?? 0)
            }
            gutter = CGFloat(max(2, String(highest).count)) * advance + 12
            width = ceil(widest) + 2 * gutter + 14 + 16
        }
    }

    var body: some View {
        if row.kind == .hunk {
            HStack(spacing: 0) {
                WrappedLine(text: row.text, color: UIColor(palette.mutedStrong))
                    .frame(width: max(0, viewport - 26))
                    .padding(.leading, 10)
                    .padding(.trailing, 16)
                    .padding(.vertical, 6)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.hunkSurface)
        } else {
            HStack(alignment: .top, spacing: 0) {
                if wrap {
                    number(row.kind == .delete ? row.oldLine : row.newLine)
                } else {
                    number(row.oldLine)
                    number(row.newLine)
                }
                Text(row.kind == .add ? "+" : row.kind == .delete ? "−" : " ")
                    .foregroundStyle(row.kind == .add ? palette.success : row.kind == .delete ? palette.danger : palette.quiet)
                    .frame(width: 14)
                    .padding(.vertical, 2)
                if wrap {
                    WrappedLine(text: row.text.isEmpty ? " " : row.text, color: UIColor(palette.ink))
                        .padding(.trailing, 16)
                        .padding(.vertical, 2)
                } else {
                    Text(row.text.isEmpty ? " " : row.text)
                        .foregroundStyle(palette.ink)
                        .fixedSize()
                        .padding(.trailing, 12)
                        .padding(.vertical, 2)
                    Spacer(minLength: 0)
                }
            }
            .font(.caption.monospaced())
            .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading)
            .background(row.kind == .add ? palette.diffAddSurface : row.kind == .delete ? palette.diffDeleteSurface : Color.clear)
        }
    }

    private func number(_ line: Int?) -> some View {
        Text(line.map(String.init) ?? "")
            .foregroundStyle(palette.quiet)
            .frame(width: gutter - 6, alignment: .trailing)
            .padding(.trailing, 6)
            .padding(.vertical, 2)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(row.kind == .add ? palette.diffAddGutter : row.kind == .delete ? palette.diffDeleteGutter : palette.sunken)
            .accessibilityHidden(true)
    }
}

/// One diff line wrapped under its own indent, as `WrappedCode` wraps a block.
private struct WrappedLine: UIViewRepresentable {
    var text: String
    var color: UIColor

    static var font: UIFont {
        UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular)
    }

    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 0
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    func updateUIView(_ label: UILabel, context: Context) {
        label.attributedText = WrappedCode.styled(text, font: Self.font, color: color)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UILabel, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        return CGSize(width: width, height: ceil(uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
    }
}
