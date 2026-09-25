import Foundation

public enum HardBlockedBundleIDs {
    public static let all: Set<String> = {
        guard let url = Bundle.module.url(forResource: "hard-blocked-bundle-ids", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let ids = try? JSONDecoder().decode([String].self, from: data),
              !ids.isEmpty else {
            preconditionFailure("Hard-blocked bundle ID resource is unavailable")
        }
        return Set(ids)
    }()
}
