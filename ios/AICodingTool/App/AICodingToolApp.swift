import SwiftUI

@main
struct AICodingToolApp: App {
    @State private var model = PhoneModel(connection: PhoneConnection())
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onOpenURL { url in
                    if let link = PairingLink(url.absoluteString) { model.connection.pair(with: link) }
                }
                .task {
                    // `npm run start:ios` hands the simulator a pairing link here; a phone already paired with that computer goes back to it.
                    guard let raw = ProcessInfo.processInfo.environment["AIC_PAIR_LINK"], let link = PairingLink(raw) else { return }
                    if let known = model.connection.computers.first(where: { $0.origin == link.origin }) {
                        model.connection.switchTo(known)
                    } else {
                        model.connection.pair(with: link)
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model.connection.becameActive()
            case .background: model.connection.resignedActive()
            default: break
            }
        }
    }
}
