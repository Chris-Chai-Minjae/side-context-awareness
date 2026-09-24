import { useEffect, useRef } from "preact/hooks"
import { t, type UiLanguage } from "../i18n"

interface ConfirmDialogProps {
  readonly language: UiLanguage
  readonly open: boolean
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly busy?: boolean
}

export function ConfirmDialog({
  language,
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDialogProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    dialog.current?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.focus()
    return () => {
      if (previous && "focus" in previous && typeof previous.focus === "function") previous.focus()
    }
  }, [open])
  if (!open) return null
  return (
    <div class="dialog-backdrop">
      <div
        ref={dialog}
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            onCancel()
          }
          if (event.key === "Tab") {
            const buttons =
              dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
            if (!buttons || buttons.length === 0) return
            const first = buttons[0]
            const last = buttons[buttons.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-body">{body}</p>
        <div class="dialog-actions">
          <button
            type="button"
            class="button button-secondary"
            data-action="cancel"
            onClick={onCancel}
          >
            {t(language, "Cancel")}
          </button>
          <button
            type="button"
            class="button button-destructive"
            data-action="confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
