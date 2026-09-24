import { z } from "zod"
import { PAUSE_INDEFINITE } from "../constants"
import { type Settings, SettingsSchema } from "../contracts/settings"

const LegacyConfigSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  pausedUntil: z.number().int().nonnegative().or(z.literal("indefinite")).nullable(),
  deniedApps: z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)).max(100),
  deniedWebsites: z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)).max(100),
  screenOcr: z.boolean(),
  captureTypedText: z.boolean(),
  summaryModel: z.string().min(1).nullable(),
  embeddingModel: z.string().min(1).nullable(),
  retentionDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]),
  intervalSeconds: z.number().int().min(1).max(600),
})

export function migrateConfig(raw: unknown): Settings {
  const legacy = LegacyConfigSchema.parse(raw)

  // A v1 model name has no provider identity; the read-only v1 file retains it.
  return SettingsSchema.parse({
    version: 2,
    contextAwareness: {
      enabled: legacy.enabled,
      pausedUntil: legacy.pausedUntil === "indefinite" ? PAUSE_INDEFINITE : legacy.pausedUntil,
      rules: [
        ...legacy.deniedApps.map((bundleId) => ({
          scope: "app" as const,
          behavior: "do_not_observe" as const,
          bundleId,
        })),
        ...legacy.deniedWebsites.map((urlDomain) => ({
          scope: "url" as const,
          behavior: "do_not_observe" as const,
          urlDomain,
        })),
      ],
      retentionDays: legacy.retentionDays,
      captureTypedText: legacy.captureTypedText,
      screenOcr: legacy.screenOcr,
    },
  })
}
