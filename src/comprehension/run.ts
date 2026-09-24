import type { Database } from "bun:sqlite"
import type { Settings } from "../contracts/settings"
import { withFence } from "../ledger/fence"
import { digestContextAwareness } from "../memory/digest"
import { assembleBriefing } from "./briefing"
import {
  AllProvidersFailedError,
  ProviderRequestError,
  resolveSummaryChain,
  summarizeBriefing,
} from "./providers"
import {
  claimSummaryJobs,
  completeSummaryJob,
  failSummaryJob,
  type SummaryCompletion,
  type SummaryJob,
} from "./queue"
import { SummaryContractError } from "./repair"
import { assembleRollupBriefing } from "./rollup"

export type SummaryPassOptions = {
  readonly db: Database
  readonly settings: Settings
  readonly getCurrentSettings?: () => Settings
  readonly dataDir: string
  readonly now: number
  readonly getMasterKey: () => Buffer | null
  readonly getApiKey?: (ref: string) => Promise<string | undefined>
  readonly onDigested?: () => Promise<void>
}

export type SummaryPassResult = {
  readonly claimed: number
  readonly completed: number
  readonly failed: number
  readonly digestedDays: number
}

function failureReason(error: unknown): string {
  if (error instanceof SummaryContractError) return "record_summary contract violated"
  if (error instanceof AllProvidersFailedError) return "all providers failed"
  if (error instanceof ProviderRequestError) return `provider HTTP ${error.status}`
  return "summary processing failed"
}

async function processJob(options: SummaryPassOptions, job: SummaryJob): Promise<boolean> {
  const { db, now } = options
  const result = await withFence(db, async (commit) => {
    const briefing = (() => {
      if (job.kind === "6h") return assembleRollupBriefing(db, job.window_from, job.window_to)
      const key = options.getMasterKey()
      if (key === null) throw new Error("Master key is unavailable")
      try {
        return assembleBriefing(db, key, job.window_from, job.window_to)
      } finally {
        key.fill(0)
      }
    })()
    if (briefing.evidenceIds.size === 0) return commit(() => false)
    const result = await summarizeBriefing({
      settings: options.settings,
      briefing,
      ...(options.getCurrentSettings ? { getCurrentSettings: options.getCurrentSettings } : {}),
      ...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
    })
    if (result.state !== "done") return commit(() => false)
    const completion: SummaryCompletion = {
      title: result.summary.title,
      description: result.summary.description,
      body: result.summary.body,
      apps: result.summary.apps,
      domains: result.summary.domains,
      citations: result.summary.citations.map(({ ref, title, url }) => ({
        ref,
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
      })),
      sourceIds: result.summary.sourceIds,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
    }
    return commit(() => completeSummaryJob(db, job, now, completion))
  })
  return result.status === "committed" && result.value
}

export async function runSummaryPass(options: SummaryPassOptions): Promise<SummaryPassResult> {
  if (!options.settings.contextAwareness.enabled)
    return { claimed: 0, completed: 0, failed: 0, digestedDays: 0 }
  const permitted = resolveSummaryChain(options.settings).some(
    ({ provider }) => provider.allowEvidence,
  )
  const jobs = permitted ? claimSummaryJobs(options.db, options.now) : []
  const outcomes = await Promise.all(
    jobs.map(async (job) => {
      try {
        return (await processJob(options, job)) ? "completed" : "discarded"
      } catch (error) {
        failSummaryJob(options.db, job, options.now, failureReason(error))
        return "failed"
      }
    }),
  )
  const digest = await digestContextAwareness(options.db, options.dataDir, options.now)
  if (digest.days > 0) await options.onDigested?.()
  return {
    claimed: jobs.length,
    completed: outcomes.filter((outcome) => outcome === "completed").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    digestedDays: digest.days,
  }
}
