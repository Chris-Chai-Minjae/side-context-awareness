import Foundation

public protocol AXTextNode {
    var role: String { get }
    var subrole: String { get }
    var value: String? { get }
    var children: [Self] { get }
}

public enum AXText {
    public static let maxNodes = 400
    public static let maxCharacters = 12_000
    public static let maxChildrenPerNode = 100

    public static func extract<Node: AXTextNode>(from root: Node) -> String {
        var queue = [root]
        var nextIndex = 0
        var parts: [String] = []
        var seen = Set<String>()
        var characterCount = 0

        while nextIndex < queue.count && nextIndex < maxNodes && characterCount < maxCharacters {
            let node = queue[nextIndex]
            nextIndex += 1
            let role = node.role

            if role == "AXSecureTextField" || node.subrole == "AXSecureTextField" {
                continue
            }

            if role == "AXStaticText", let value = node.value {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty && seen.insert(trimmed).inserted {
                    let separatorCount = parts.isEmpty ? 0 : 1
                    let remaining = maxCharacters - characterCount - separatorCount
                    if remaining <= 0 { break }
                    let excerpt = String(trimmed.prefix(remaining))
                    parts.append(excerpt)
                    characterCount += separatorCount + excerpt.count
                }
            }

            queue.append(contentsOf: node.children.prefix(maxChildrenPerNode))
        }

        return parts.joined(separator: "\n")
    }
}
