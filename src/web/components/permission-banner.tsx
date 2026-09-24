import { t, type UiLanguage } from "../i18n"

export type BannerKind =
  | "none"
  | "starting"
  | "not_running"
  | "permissions_needed"
  | "some_unavailable"

interface PermissionBannerProps {
  readonly language: UiLanguage
  readonly banner: BannerKind
  readonly onAllow: () => void
  readonly busy?: boolean
}

const copy = {
  starting: "Starting capture…",
  not_running: "Capture is not running",
  permissions_needed: "Permissions needed",
  some_unavailable: "Some capture features are unavailable",
} as const

export function PermissionBanner({
  language,
  banner,
  onAllow,
  busy = false,
}: PermissionBannerProps) {
  if (banner === "none") return null
  const actionable = banner === "permissions_needed" || banner === "some_unavailable"
  return (
    <section class="permission-banner" role={actionable ? "alert" : "status"}>
      <span>{t(language, copy[banner])}</span>
      {actionable && (
        <button type="button" class="button button-secondary" onClick={onAllow} disabled={busy}>
          {t(language, "Allow")}
        </button>
      )}
    </section>
  )
}
