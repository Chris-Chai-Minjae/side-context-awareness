import { z } from "zod"
import { CA_MEMORY_SEARCH_MAX_LIMIT } from "../constants"
import { PermissionKindSchema } from "./protocol"
import {
  AgentConnectionSchema,
  AppIconSchema,
  ApplicationSchema,
  CaptureStatusSchema,
  ClearOperationSchema,
  DayPageSchema,
  EvidenceSchema,
  HistoryStatusSchema,
  HistorySummarySchema,
  McpUsageSchema,
  PauseResultSchema,
  PermissionsSchema,
  ProviderModelListSchema,
  ProviderTestResultSchema,
  SettingsResourceSchema,
  SummaryModelDefaultSchema,
} from "./rpc-resources"
import { SettingsPatchSchema } from "./settings"

const EmptyInput = z.union([z.undefined(), z.strictObject({})])
const EpochMs = z.number().int()
const DateOrEpoch = z.union([z.iso.datetime({ offset: true }), EpochMs])
const SourceRef = z.string().regex(/^[es]:[0-9A-HJKMNP-TV-Z]{26}$/)

const EventMetadataSchema = z.strictObject({
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  occurred_at: EpochMs,
  source: z.string(),
  kind: z.string(),
  app_name: z.string(),
  bundle_id: z.string(),
  window_title: z.string(),
  url: z.string().url().nullable(),
  domain: z.string().nullable(),
  session_id: z.string().nullable(),
})

const SearchHitSchema = z.strictObject({
  ref: z.string(),
  occurredAt: EpochMs,
  app: z.string(),
  title: z.string(),
  url: z.string().url().nullable(),
  domain: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
})

const MemorySearchHitSchema = z.strictObject({
  chunkId: z.string(),
  day: z.iso.date(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  heading: z.string(),
  snippet: z.string(),
  summaryId: z.string().nullable(),
  score: z.number(),
})

export const RpcMethods = {
  status: {
    input: z.union([z.undefined(), z.strictObject({ url: z.string().url().optional() })]),
    output: CaptureStatusSchema,
  },
  permissions: { input: EmptyInput, output: PermissionsSchema },
  requestPermissions: {
    input: z.union([
      z.undefined(),
      z.strictObject({ kinds: z.array(PermissionKindSchema).optional() }),
    ]),
    output: PermissionsSchema,
  },
  events: {
    input: z.strictObject({
      from: EpochMs,
      to: EpochMs,
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
    }),
    output: z.array(EventMetadataSchema),
  },
  search: {
    input: z.strictObject({
      queries: z.array(z.string()).min(1).max(8),
      from: DateOrEpoch.optional(),
      to: DateOrEpoch.optional(),
      app: z.string().optional(),
      domain: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    output: z.array(SearchHitSchema),
  },
  read: {
    input: z.strictObject({
      id: SourceRef,
      match: z.string().optional(),
      contextLines: z.number().int().min(0).max(100).optional(),
    }),
    output: EvidenceSchema.nullable(),
  },
  memorySearch: {
    input: z.strictObject({
      query: z.string(),
      limit: z.number().int().min(1).max(CA_MEMORY_SEARCH_MAX_LIMIT).optional(),
      from: DateOrEpoch.optional(),
      to: DateOrEpoch.optional(),
    }),
    output: z.array(MemorySearchHitSchema),
  },
  pause: {
    input: z.union([
      z.strictObject({ until: EpochMs }),
      z.strictObject({ durationMs: z.number().int().positive() }),
    ]),
    output: PauseResultSchema,
  },
  resume: { input: EmptyInput, output: z.null() },
  clear: {
    input: z.strictObject({ target: z.enum(["last10m", "lastHour", "today", "all"]) }),
    output: ClearOperationSchema,
  },
  historyList: {
    input: z.strictObject({ from: EpochMs, to: EpochMs }),
    output: z.array(HistorySummarySchema),
  },
  historyStatus: { input: EmptyInput, output: HistoryStatusSchema },
  listApplications: { input: EmptyInput, output: z.array(ApplicationSchema) },
  appIcons: {
    input: z.strictObject({ bundleIds: z.array(z.string()) }),
    output: z.array(AppIconSchema),
  },
  summaryModelDefault: { input: EmptyInput, output: SummaryModelDefaultSchema },
  "settings.get": { input: EmptyInput, output: SettingsResourceSchema },
  "settings.patch": { input: SettingsPatchSchema, output: SettingsResourceSchema },
  digest: {
    input: z.union([z.undefined(), z.strictObject({ day: z.iso.date().optional() })]),
    output: z.strictObject({
      days: z.number().int().nonnegative(),
      summaries: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  },
  "day.get": {
    input: z.strictObject({ date: z.iso.date() }),
    output: DayPageSchema.nullable(),
  },
  "providers.setKey": {
    input: z.strictObject({ providerId: z.string(), apiKey: z.string() }),
    output: z.strictObject({ apiKeyRef: z.string() }),
  },
  "providers.listModels": {
    input: z.strictObject({ providerId: z.string() }),
    output: ProviderModelListSchema,
  },
  "providers.test": {
    input: z.strictObject({ providerId: z.string(), modelId: z.string() }),
    output: ProviderTestResultSchema,
  },
  "mcp.usage": {
    input: z.strictObject({ sinceMs: EpochMs }),
    output: z.array(McpUsageSchema),
  },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

export type RpcMethodName = keyof typeof RpcMethods

export const RpcResourceFieldSchemas: Record<string, readonly z.ZodObject[]> = {
  capture_status: [RpcMethods.status.output],
  permissions: [RpcMethods.permissions.output],
  pause: [RpcMethods.pause.output],
  settings: [RpcMethods["settings.get"].output],
  applications: [RpcMethods.listApplications.output.element, RpcMethods.appIcons.output.element],
  summary_model_default: [RpcMethods.summaryModelDefault.output],
  providers: [RpcMethods["settings.get"].output.shape.providers.element],
  history_status: [RpcMethods.historyStatus.output],
  history_summaries: [RpcMethods.historyList.output.element],
  day_pages: [RpcMethods["day.get"].output.unwrap()],
  evidence: [RpcMethods.read.output.unwrap()],
  clear_operation: [RpcMethods.clear.output],
  mcp_usage: [RpcMethods["mcp.usage"].output.element],
  agent_connection: [AgentConnectionSchema],
}
