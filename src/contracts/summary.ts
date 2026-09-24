import { z } from "zod"

const SourceRefSchema = z.string().regex(/^[es]:[0-9A-HJKMNP-TV-Z]{26}$/)

export const RecordSummaryArgumentsSchema = z.strictObject({
  title: z
    .string()
    .max(80)
    .refine((value) => value.trim().length > 0),
  description: z.array(z.string().max(240)).min(1).max(3),
  memorySummary: z.string().max(2000),
  priorContext: z.string().max(600).optional(),
  userEntities: z.array(z.string().max(80)).max(20).optional(),
  recordingSummary: z.string().max(600).optional(),
  apps: z.array(z.string()).max(20),
  domains: z.array(z.string()).max(20),
  citations: z
    .array(
      z.strictObject({
        ref: SourceRefSchema,
        title: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .max(30),
  sourceIds: z.array(SourceRefSchema).max(200),
})

export type RecordSummaryArguments = z.infer<typeof RecordSummaryArgumentsSchema>

export const RecordSummaryTool = {
  name: "record_summary",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "description",
      "memorySummary",
      "apps",
      "domains",
      "citations",
      "sourceIds",
    ],
    properties: {
      title: { type: "string", maxLength: 80 },
      description: {
        type: "array",
        items: { type: "string", maxLength: 240 },
        minItems: 1,
        maxItems: 3,
      },
      memorySummary: { type: "string", maxLength: 2000 },
      priorContext: { type: "string", maxLength: 600 },
      userEntities: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 20 },
      recordingSummary: { type: "string", maxLength: 600 },
      apps: { type: "array", items: { type: "string" }, maxItems: 20 },
      domains: { type: "array", items: { type: "string" }, maxItems: 20 },
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref"],
          properties: {
            ref: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
          },
        },
        maxItems: 30,
      },
      sourceIds: { type: "array", items: { type: "string" }, maxItems: 200 },
    },
  },
} as const
