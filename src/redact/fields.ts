export type CaptureField = {
  readonly role?: string
  readonly subrole?: string
  readonly autocomplete?: string
  readonly inputType?: string
  readonly label?: string
  readonly title?: string
  readonly description?: string
  readonly placeholder?: string
  readonly axTitle?: string
  readonly axDescription?: string
  readonly axPlaceholderValue?: string
  readonly ariaName?: string
}

export type FieldSuppressionRule =
  | "secure-text-field"
  | "autocomplete"
  | "input-type"
  | "field-label"

const AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
])

const SENSITIVE_LABEL =
  /(^|[^a-z])(cvv|cvc|csc|otp|one[- ]?time|pin|passcode|password|passwd|ssn|social security|security[- ]?code|card[- ]?number|카드\s*번호|비밀\s*번호|인증\s*번호|주민\s*(등록)?\s*번호|보안\s*코드)([^a-z]|$)/i

export function sensitiveFieldRule(field: CaptureField): FieldSuppressionRule | null {
  if (field.role === "AXSecureTextField" || field.subrole === "AXSecureTextField")
    return "secure-text-field"
  if (
    field.autocomplete
      ?.toLowerCase()
      .split(/\s+/u)
      .some((token) => AUTOCOMPLETE_TOKENS.has(token))
  ) {
    return "autocomplete"
  }
  const inputType = field.inputType?.toLowerCase()
  if (inputType === "password" || inputType === "tel") return "input-type"
  const labels = [
    field.label,
    field.title,
    field.description,
    field.placeholder,
    field.axTitle,
    field.axDescription,
    field.axPlaceholderValue,
    field.ariaName,
  ]
  if (labels.some((label) => label !== undefined && SENSITIVE_LABEL.test(label))) {
    return "field-label"
  }
  return null
}

export function shouldBlockField(field: CaptureField): boolean {
  return sensitiveFieldRule(field) !== null
}
