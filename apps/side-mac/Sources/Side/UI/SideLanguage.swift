enum SideLanguage: String, CaseIterable, Decodable {
    case ko
    case en

    func localized(_ english: String, _ korean: String) -> String {
        switch self {
        case .ko: return korean
        case .en: return english
        }
    }
}
