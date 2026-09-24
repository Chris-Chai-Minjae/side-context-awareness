import Foundation

public struct FieldMetadata: Decodable {
    public let role: String?
    public let subrole: String?
    public let title: String?
    public let description: String?
    public let placeholder: String?
    public let ariaName: String?
    public let autocomplete: String?
    public let inputType: String?

    public init(
        role: String? = nil,
        subrole: String? = nil,
        title: String? = nil,
        description: String? = nil,
        placeholder: String? = nil,
        ariaName: String? = nil,
        autocomplete: String? = nil,
        inputType: String? = nil
    ) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.description = description
        self.placeholder = placeholder
        self.ariaName = ariaName
        self.autocomplete = autocomplete
        self.inputType = inputType
    }
}

public enum FieldBlockRule: String {
    case secureTextField = "secure-text-field"
    case autocomplete = "autocomplete"
    case inputType = "input-type"
    case label = "field-label"
}

public enum FieldLabels {
    private static let blockedAutocomplete: Set<String> = [
        "current-password", "new-password", "one-time-code", "cc-number", "cc-csc",
        "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name",
    ]
    private static let blockedInputTypes: Set<String> = ["password", "tel"]
    private static let labelPattern = try! NSRegularExpression(
        pattern: #"(^|[^a-z])(cvv|cvc|csc|otp|one[- ]?time|pin|passcode|password|passwd|ssn|social security|security[- ]?code|card[- ]?number|카드\s*번호|비밀\s*번호|인증\s*번호|주민\s*(등록)?\s*번호|보안\s*코드)([^a-z]|$)"#,
        options: [.caseInsensitive]
    )

    public static func blockedRule(for field: FieldMetadata) -> FieldBlockRule? {
        if field.role == "AXSecureTextField" || field.subrole == "AXSecureTextField" {
            return .secureTextField
        }
        if let autocomplete = field.autocomplete,
           autocomplete.lowercased().split(whereSeparator: { $0.isWhitespace }).contains(where: {
               blockedAutocomplete.contains(String($0))
           }) {
            return .autocomplete
        }
        if let inputType = field.inputType, blockedInputTypes.contains(inputType.lowercased()) {
            return .inputType
        }
        for label in [field.title, field.description, field.placeholder, field.ariaName].compactMap({ $0 }) {
            let range = NSRange(label.startIndex..<label.endIndex, in: label)
            if labelPattern.firstMatch(in: label, range: range) != nil {
                return .label
            }
        }
        return nil
    }
}
