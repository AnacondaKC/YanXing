import type { TLocalizedValidationError } from 'typebox/error'
import type { GateError } from '@/modules/contracts/analysis'

export const MAX_GATE_ERRORS = 50

const MAX_PATH_LENGTH = 200
const MAX_MESSAGE_LENGTH = 500
const MAX_EXPECTED_LENGTH = 200
const PATH_TRUNCATION_MARK = '…'
const SCHEMA_INVALID_CODE = 'SCHEMA_INVALID'

const TYPE_LABELS: Record<string, string> = {
  array: '数组',
  boolean: '布尔值',
  integer: '整数',
  null: '空值',
  number: '数字',
  object: '对象',
  string: '字符串',
}

export function toSchemaGateErrors(errors: readonly TLocalizedValidationError[]): GateError[] {
  const gateErrors: GateError[] = []
  for (const error of errors) {
    for (const gateError of adaptSchemaError(error)) {
      gateErrors.push(gateError)
      if (gateErrors.length >= MAX_GATE_ERRORS) return gateErrors
    }
  }
  return gateErrors
}

function adaptSchemaError(error: TLocalizedValidationError): GateError[] {
  switch (error.keyword) {
    case 'type':
      return [adaptTypeError(error)]
    case 'required':
      return adaptNamedProperties(error, error.params.requiredProperties, describeMissingProperty)
    case 'additionalProperties':
      return adaptNamedProperties(error, error.params.additionalProperties, describeExtraProperty)
    case 'minItems':
      return [adaptLimitError(error.instancePath, `至少需要 ${error.params.limit} 项。`, error.params.limit)]
    case 'maxItems':
      return [adaptLimitError(error.instancePath, `最多允许 ${error.params.limit} 项。`, error.params.limit)]
    case 'minLength':
      return [adaptLimitError(error.instancePath, `长度不能少于 ${error.params.limit} 个字符。`, error.params.limit)]
    case 'maxLength':
      return [adaptLimitError(error.instancePath, `长度不能超过 ${error.params.limit} 个字符。`, error.params.limit)]
    case 'minProperties':
      return [adaptLimitError(error.instancePath, `至少需要 ${error.params.limit} 个字段。`, error.params.limit)]
    case 'maxProperties':
      return [adaptLimitError(error.instancePath, `最多允许 ${error.params.limit} 个字段。`, error.params.limit)]
    case 'minimum':
      return [adaptLimitError(error.instancePath, `值必须大于或等于 ${error.params.limit}。`, error.params.limit)]
    case 'maximum':
      return [adaptLimitError(error.instancePath, `值必须小于或等于 ${error.params.limit}。`, error.params.limit)]
    case 'exclusiveMinimum':
      return [adaptLimitError(error.instancePath, `值必须大于 ${error.params.limit}。`, error.params.limit)]
    case 'exclusiveMaximum':
      return [adaptLimitError(error.instancePath, `值必须小于 ${error.params.limit}。`, error.params.limit)]
    case 'multipleOf':
      return [adaptLimitError(error.instancePath, `值必须是 ${error.params.multipleOf} 的倍数。`, error.params.multipleOf)]
    default:
      return [adaptFallbackError(error)]
  }
}

function adaptTypeError(error: Extract<TLocalizedValidationError, { keyword: 'type' }>): GateError {
  const expected = formatExpectedType(error.params.type)
  return createGateError(normalizeInstancePath(error.instancePath), `类型必须是${formatChineseType(error.params.type)}。`, expected)
}

function describeMissingProperty(property: string) {
  return { message: `缺少必填字段 ${property}。`, expected: property }
}

function describeExtraProperty(property: string) {
  return { message: `不允许额外字段 ${property}。` }
}

function adaptNamedProperties(
  error: TLocalizedValidationError,
  properties: readonly string[],
  describe: (property: string) => { message: string; expected?: string },
): GateError[] {
  if (properties.length === 0) return [adaptFallbackError(error)]
  return properties.slice(0, MAX_GATE_ERRORS).map((property) => {
    const description = describe(property)
    return createGateError(childPointer(error.instancePath, property), description.message, description.expected)
  })
}

function adaptLimitError(instancePath: string, message: string, limit: number | bigint): GateError {
  return createGateError(normalizeInstancePath(instancePath), message, String(limit))
}

function adaptFallbackError(error: TLocalizedValidationError): GateError {
  return createGateError(normalizeInstancePath(error.instancePath), error.message)
}

function createGateError(path: string, message: string, expected?: string): GateError {
  const gateError: GateError = {
    code: SCHEMA_INVALID_CODE,
    path: limitPath(path),
    message: limitText(message, MAX_MESSAGE_LENGTH),
  }
  if (expected !== undefined) gateError.expected = limitText(expected, MAX_EXPECTED_LENGTH)
  return gateError
}

function formatExpectedType(type: string | string[]): string {
  return typeof type === 'string' ? type : type.join(' | ')
}

function formatChineseType(type: string | string[]): string {
  return (typeof type === 'string' ? [type] : type).map((item) => TYPE_LABELS[item] ?? item).join('或')
}

function normalizeInstancePath(instancePath: string): string {
  return instancePath === '' ? '/' : instancePath
}

function childPointer(instancePath: string, token: string): string {
  const parent = instancePath === '' || instancePath === '/' ? '' : instancePath
  return `${parent}/${escapeJsonPointerToken(token)}`
}

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

function limitPath(path: string): string {
  if (path.length <= MAX_PATH_LENGTH) return path
  const lastSlash = path.lastIndexOf('/')
  const field = lastSlash >= 0 ? path.slice(lastSlash) : path
  const markedBudget = MAX_PATH_LENGTH - PATH_TRUNCATION_MARK.length
  if (field.length <= markedBudget) {
    return `${path.slice(0, markedBudget - field.length)}${PATH_TRUNCATION_MARK}${field}`
  }
  return `${path.slice(0, markedBudget)}${PATH_TRUNCATION_MARK}`
}

function limitText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength)
}
