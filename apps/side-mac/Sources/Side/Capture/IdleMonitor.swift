import Carbon
import CoreGraphics
import Foundation

struct IdleMonitor {
    static let attentionInputFreshSeconds: TimeInterval = 180

    private let secondsSinceLastInput: () -> TimeInterval
    private let secureInputEnabled: () -> Bool

    init(
        secondsSinceLastInput: @escaping () -> TimeInterval = {
            CGEventSource.secondsSinceLastEventType(
                .combinedSessionState,
                eventType: CGEventType(rawValue: UInt32.max)!
            )
        },
        secureInputEnabled: @escaping () -> Bool = { IsSecureEventInputEnabled() }
    ) {
        self.secondsSinceLastInput = secondsSinceLastInput
        self.secureInputEnabled = secureInputEnabled
    }

    var idleSeconds: TimeInterval { secondsSinceLastInput() }
    var isIdle: Bool { idleSeconds > Self.attentionInputFreshSeconds }
    var isSecureInputEnabled: Bool { secureInputEnabled() }
}
