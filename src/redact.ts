const MASK = "[redacted:capture]"

function validCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/gu, "")
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
      MASK,
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, MASK)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, MASK)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, MASK)
    .replace(
      /\b(?:api[_ -]?key|access[_ -]?token|secret|password|otp|pin)\s*[:=]\s*[^\s,;]+/giu,
      MASK,
    )
    .replace(/\b(?:\d[ -]?){12,18}\d\b/gu, (candidate) => (validCard(candidate) ? MASK : candidate))
}
