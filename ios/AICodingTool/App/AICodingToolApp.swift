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
