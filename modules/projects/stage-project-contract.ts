import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'
import { PROJECT_FIELD_LIMITS as limits } from '@/modules/projects/validation'

const identity = Type.String({minLength:1,maxLength:100,pattern:'^[A-Za-z0-9_-]+$'})
const stage = Type.Object({id:identity,title:Type.String({minLength:1,maxLength:limits.milestoneTitle}),
  description:Type.Optional(Type.String({maxLength:limits.milestoneDescription})),
  plannedStartAt:Type.Optional(Type.String()),plannedEndAt:Type.Optional(Type.String()),
},{additionalProperties:false})
export const StageProjectCreateSchema = Type.Object({
  title:Type.String({minLength:1,maxLength:limits.title}),objective:Type.String({minLength:1,maxLength:limits.objective}),
  description:Type.String({minLength:1,maxLength:limits.description}),ownerId:identity,
  collaboratorIds:Type.Optional(Type.Array(identity,{maxItems:limits.collaborators,uniqueItems:true})),
  stages:Type.Array(stage,{minItems:1,maxItems:limits.milestones}),
},{additionalProperties:false})
export const StagePlanEditSchema = Type.Object({expectedPlanRevision:Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER}),
  nextStages:Type.Array(stage,{minItems:1,maxItems:limits.milestones}),
},{additionalProperties:false})
export type StageProjectCreate = Static<typeof StageProjectCreateSchema>
export type StagePlanEdit = Static<typeof StagePlanEditSchema>
export const isStageProjectCreate = (value:unknown):value is StageProjectCreate => Value.Check(StageProjectCreateSchema,value)
export const isStagePlanEdit = (value:unknown):value is StagePlanEdit => Value.Check(StagePlanEditSchema,value)
