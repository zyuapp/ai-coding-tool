import UIKit
import UserNotifications

/// What a computer's notice names: the pairing it was sent to, and the thread a tap opens.
struct NoticeTarget: Equatable, Sendable {
    var deviceId: String
    var taskId: String
    var title: String

    /// The group the relay files a thread's notices under, which `thread-id` carries.
    var group: String { "\(deviceId):\(taskId)" }

    init?(_ content: UNNotificationContent) {
        guard let deviceId = content.userInfo["deviceId"] as? String, let taskId = content.userInfo["taskId"] as? String else { return nil }
        self.deviceId = deviceId
        self.taskId = taskId
        title = content.title
    }
}

/// Notices from the computer while the app is closed: asks to show them, hands the push token to the
/// connection, keeps quiet about the thread already on screen, and opens the one a tap names.
@MainActor
final class PushNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotifications()

    private weak var model: PhoneModel?
    /// A tap that launched the app arrives before the model does, and waits for it.
    private var pendingTap: NoticeTarget?

    static var environment: PhonePush.Environment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }

    func attach(_ model: PhoneModel) {
        self.model = model
        if let pendingTap {
            self.pendingTap = nil
            open(pendingTap)
        }
    }

    /// Keeps the token current while notices are allowed, and gives it up once they are not. The
    /// question is asked only when `ask` says so, which is once the phone is paired and connected.
    func refresh(ask: Bool) {
        Task {
            let center = UNUserNotificationCenter.current()
            switch await center.notificationSettings().authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                UIApplication.shared.registerForRemoteNotifications()
            case .notDetermined:
                guard ask, (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
                UIApplication.shared.registerForRemoteNotifications()
            default:
                model?.connection.setPush(nil)
            }
        }
    }

    func registered(_ deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        model?.connection.setPush(PhonePush(token: token, environment: Self.environment))
    }

    /// Takes a thread's notices off the lock screen and out of Notification Center once it is open here.
    func cleared(deviceId: String?, taskId: String) {
        guard let deviceId else { return }
        let group = "\(deviceId):\(taskId)"
        Task {
            let center = UNUserNotificationCenter.current()
            let delivered = await center.deliveredNotifications().filter { $0.request.content.threadIdentifier == group }
            if !delivered.isEmpty { center.removeDeliveredNotifications(withIdentifiers: delivered.map(\.request.identifier)) }
        }
    }

    private func showing(_ target: NoticeTarget) -> Bool {
        guard let model, UIApplication.shared.applicationState == .active else { return false }
        return model.connection.state.credential?.deviceId == target.deviceId && model.current == target.taskId && model.path.last == .thread
    }

    private func open(_ target: NoticeTarget) {
        guard let model else {
            pendingTap = target
            return
        }
        if let computer = model.connection.computers.first(where: { $0.credential.deviceId == target.deviceId }) {
            model.connection.switchTo(computer)
        }
        guard model.connection.state.credential?.deviceId == target.deviceId else { return }
        model.openThread(target.taskId, title: target.title, project: nil)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard let target = NoticeTarget(notification.request.content) else { return [.banner, .list, .sound] }
        return await showing(target) ? [] : [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier, let target = NoticeTarget(response.notification.request.content) else { return }
        await open(target)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = PushNotifications.shared
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotifications.shared.registered(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Could not register for notifications:", error.localizedDescription)
    }
}
