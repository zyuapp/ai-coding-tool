import SwiftUI

/// The computer's archived threads, newest first, each put back in the list with Restore. The list is
/// read on request and again whenever the computer's count of them moves.
struct ArchivedScreen: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var rows: [MobileArchivedThread]?
    @State private var problem: String?
    @State private var restoring: Set<String> = []
    @State private var now = Date()

    var body: some View {
        List {
            if let rows {
                if rows.isEmpty {
                    ContentUnavailableView("Nothing Archived", systemImage: "archivebox", description: Text("Archived threads stay here for 5 days."))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .padding(.top, 60)
                } else {
                    ForEach(rows) { row($0) }
                    Text("Archived threads stay for 5 days, then your computer deletes them.")
                        .font(.footnote)
                        .foregroundStyle(palette.muted)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .padding(.top, 4)
                }
            } else if let problem {
                ContentUnavailableView {
                    Label("Couldn't Read the Archive", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(problem)
                } actions: {
                    Button("Try Again") { Task { await load() } }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .padding(.top, 60)
            } else {
                HStack {
                    Spacer()
                    ProgressView().tint(palette.muted)
                    Spacer()
                }
                .padding(.top, 80)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .screenBackground(palette)
        .notice(model)
        .navigationTitle("Archived")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: "\(model.view.archived ?? -1):\(model.live)") {
            now = Date()
            await load()
        }
        .onChange(of: model.state.returned?.requestId) { _, _ in
            if let returned = model.state.returned, returned.command.type == "task.restore", let taskId = returned.command.taskId {
                restoring.remove(taskId)
            }
        }
    }

    private func load() async {
        guard model.live else { return }
        do {
            let read = try await model.connection.query(.archived).decode([MobileArchivedThread].self)
            rows = read
            problem = nil
            restoring.formIntersection(read.map(\.id))
        } catch {
            if rows == nil { problem = error.localizedDescription }
        }
    }

    private func row(_ thread: MobileArchivedThread) -> some View {
        let busy = restoring.contains(thread.id)
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Text("\(thread.projectName ?? "No project") · \(Format.deletesIn(thread.deletesAt, now: now))")
                    .font(.footnote)
                    .foregroundStyle(palette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                restoring.insert(thread.id)
                model.send(.restore(thread.id))
            } label: {
                ZStack {
                    Text("Restore").opacity(busy ? 0 : 1)
                    if busy { ProgressView().controlSize(.small).tint(palette.accent) }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.accent)
                .padding(.horizontal, 14)
                .frame(height: 32)
                .background(palette.accentChip, in: Capsule())
            }
            .buttonStyle(.target)
            .disabled(busy)
            .accessibilityLabel(busy ? "Restoring \(thread.title)" : "Restore \(thread.title)")
        }
        .padding(.vertical, 8)
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(palette.lineSoft)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                restoring.insert(thread.id)
                model.send(.restore(thread.id))
            } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                .tint(palette.accent)
        }
    }
}
