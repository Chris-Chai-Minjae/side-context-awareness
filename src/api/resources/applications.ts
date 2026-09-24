import { z } from "zod"
import { APPLICATION_ICON_CACHE_LIMIT } from "../../constants"
import { RpcMethods } from "../../contracts/rpc"
import type { Settings } from "../../contracts/settings"
import type { HelperCommandRequest } from "../../helper/client"
import { isDeniedApp } from "../../policy/index"
import type { RpcHandlers } from "../rpc"

const HelperApplication = z.strictObject({
  bundleId: z.string(),
  name: z.string(),
  denied: z.boolean(),
})
const HelperIcon = z.strictObject({
  bundleId: z.string(),
  iconPngBase64: z.string(),
})

type ApplicationDependencies = {
  readonly getSettings: () => Settings
  readonly helper: { readonly sendCommand: (command: HelperCommandRequest) => Promise<unknown> }
}

export function createApplicationsHandlers(
  dependencies: ApplicationDependencies,
): Pick<RpcHandlers, "listApplications" | "appIcons"> {
  const icons = new Map<string, string>()
  const touch = (bundleId: string, icon: string): void => {
    icons.delete(bundleId)
    icons.set(bundleId, icon)
    if (icons.size > APPLICATION_ICON_CACHE_LIMIT) {
      const oldest = icons.keys().next().value
      if (oldest !== undefined) icons.delete(oldest)
    }
  }
  return {
    async listApplications() {
      const result = await dependencies.helper.sendCommand({
        type: "command",
        name: "applications.list",
      })
      const apps = z.array(HelperApplication).parse(result)
      const rules = dependencies.getSettings().contextAwareness.rules
      return apps.map((app) => ({
        bundle_id: app.bundleId,
        name: app.name,
        denied: app.denied || isDeniedApp(app.bundleId, rules),
      }))
    },
    async appIcons(value) {
      const { bundleIds } = RpcMethods.appIcons.input.parse(value)
      const requested = [...new Set(bundleIds)]
      const resolved = new Map<string, string>()
      for (const bundleId of requested) {
        const icon = icons.get(bundleId)
        if (icon !== undefined) resolved.set(bundleId, icon)
      }
      const missing = requested.filter((bundleId) => !resolved.has(bundleId))
      if (missing.length > 0) {
        const result = await dependencies.helper.sendCommand({
          type: "command",
          name: "applications.icons",
          args: { bundleIds: missing },
        })
        const allowed = new Set(missing)
        for (const icon of z.array(HelperIcon).parse(result)) {
          if (allowed.has(icon.bundleId)) {
            resolved.set(icon.bundleId, icon.iconPngBase64)
            touch(icon.bundleId, icon.iconPngBase64)
          }
        }
      }
      return requested.flatMap((bundleId) => {
        const icon = resolved.get(bundleId)
        if (icon === undefined) return []
        if (icons.has(bundleId)) touch(bundleId, icon)
        return [{ bundle_id: bundleId, icon_png_base64: icon }]
      })
    },
  }
}
