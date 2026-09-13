import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'
import { PROJECT_FIELD_LIMITS } from '@/modules/projects/validation'

const Identifier = Type.String({ minLength: 1, maxLength: PROJECT_FIELD_LIMITS.reportId, pattern: '^[A-Za-z0-9_-]+$' })
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

export const ReportSubmissionCommandSchema = Type.Object({
  uploadId: Identifier,
  stageId: Identifier,
  reportKind: Type.Union([Type.Literal('update'), Type.Literal('completion')]),
  expectedPlanRevision: Revision,
  expectedWorkflowRevision: Revision,
  expectedCompletionRevision: Revision,
  expectedCompletionReportId: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false })

export type ReportSubmissionCommand = Static<typeof ReportSubmissionCommandSchema>

export function isReportSubmissionCommand(value: unknown): value is ReportSubmissionCommand {
  return Value.Check(ReportSubmissionCommandSchema, value)
}

export function isReportSubmissionIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}
