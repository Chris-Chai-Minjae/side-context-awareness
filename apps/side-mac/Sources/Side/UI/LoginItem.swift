import Combine
import ServiceManagement

enum LoginItemStatus {
    case notRegistered, enabled, requiresApproval, notFound
}

@MainActor
protocol LoginItemServicing: AnyObject {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
}

@MainActor
final class SystemLoginItemService: LoginItemServicing {
    var status: LoginItemStatus {
        switch SMAppService.mainApp.status {
        case .notRegistered: return .notRegistered
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notFound: return .notFound
        @unknown default: return .notFound
        }
    }

    func register() throws { try SMAppService.mainApp.register() }
    func unregister() throws { try SMAppService.mainApp.unregister() }
}

@MainActor
final class LoginItemState: ObservableObject {
    static let shared = LoginItemState(service: SystemLoginItemService())

    @Published private(set) var isEnabled = false
    @Published private(set) var requiresApproval = false
    @Published private(set) var isWorking = false
    @Published private(set) var errorMessage: String?

    private let service: LoginItemServicing

    init(service: LoginItemServicing) {
        self.service = service
        refresh()
    }

    func refresh() {
        let status = service.status
        isEnabled = status == .enabled || status == .requiresApproval
        requiresApproval = status == .requiresApproval
    }

    func setEnabled(_ enabled: Bool) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            if enabled {
                try service.register()
            } else {
                try service.unregister()
            }
            errorMessage = nil
        } catch {
            errorMessage = "Could not update Open at Login. Check System Settings and try again."
        }
        refresh()
    }
}
