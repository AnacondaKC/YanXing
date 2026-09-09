import assert from 'node:assert/strict'
import test from 'node:test'
import { Type, type TSchema } from 'typebox'
import { Value } from 'typebox/value'
import { validateModuleOutput } from '../modules/analysis/gates'
import { MAX_GATE_ERRORS } from '../modules/analysis/schema-errors'
import type { GateError } from '../modules/contracts/analysis'

function validate(schema: TSchema, output: unknown) {
  return validateModuleOutput({ schema, output })
}

function errorByPath(errors: readonly GateError[], path: string) {
  return errors.find((error) => error.path === path)
}

test('schema errors report a deep instance path', () => {
  const schema = Type.Object({
    outer: Type.Object({
      items: Type.Array(Type.Object({
        name: Type.String(),
        count: Type.Integer(),
      })),
    }),
  })
  const result = validate(schema, { outer: { items: [{ name: 1, count: 2 }] } })
  assert.equal(result.accepted, false)
  const error = errorByPath(result.errors, '/outer/items/0/name')
  assert.ok(error)
  assert.equal(error.code, 'SCHEMA_INVALID')
  assert.equal(error.message, '类型必须是字符串。')
  assert.equal(error.expected, 'string')
})

test('schema errors escape ~ and / when expanding field paths', () => {
  const schema = Type.Object({
    parent: Type.Object({
      'tilde~name': Type.String(),
      'slash/name': Type.Number(),
    }, { additionalProperties: false }),
  })
  const missing = validate(schema, { parent: {} })
  assert.equal(missing.accepted, false)
  const tilde = errorByPath(missing.errors, '/parent/tilde~0name')
  const slash = errorByPath(missing.errors, '/parent/slash~1name')
  assert.ok(tilde)
  assert.ok(slash)
  assert.equal(tilde.message, '缺少必填字段 tilde~name。')
  assert.equal(slash.message, '缺少必填字段 slash/name。')
  assert.equal(errorByPath(missing.errors, '/parent/tilde~name'), undefined)
  assert.equal(errorByPath(missing.errors, '/parent/slash/name'), undefined)

  const extra = validate(schema, {
    parent: { 'tilde~name': 'ok', 'slash/name': 1, 'extra~field/name': true },
  })
  const extraError = extra.errors.find((error) => error.message.includes('extra~field/name'))
  assert.ok(extraError)
  assert.equal(extraError.path, '/parent/extra~0field~1name')
  assert.equal(extraError.message, '不允许额外字段 extra~field/name。')
})

test('schema errors use / for the root path', () => {
  const result = validate(Type.Object({ name: Type.String() }), 1)
  assert.equal(result.accepted, false)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.path, '/')
  assert.equal(result.errors[0]?.code, 'SCHEMA_INVALID')
  assert.equal(result.errors[0]?.message, '类型必须是对象。')
  assert.equal(result.errors[0]?.expected, 'object')
})

test('schema errors expand multiple required properties onto field paths', () => {
  const schema = Type.Object({
    title: Type.String(),
    count: Type.Number(),
    ready: Type.Boolean(),
  })
  const result = validate(schema, {})
  assert.equal(result.accepted, false)
  assert.deepEqual(
    result.errors.map((error) => ({ path: error.path, message: error.message, expected: error.expected })),
    [
      { path: '/title', message: '缺少必填字段 title。', expected: 'title' },
      { path: '/count', message: '缺少必填字段 count。', expected: 'count' },
      { path: '/ready', message: '缺少必填字段 ready。', expected: 'ready' },
    ],
  )
})

test('schema errors put the expected type on type mismatches', () => {
  const schema = Type.Object({
    name: Type.String(),
    count: Type.Integer(),
  })
  const result = validate(schema, { name: 1, count: 1.5 })
  const name = errorByPath(result.errors, '/name')
  const count = errorByPath(result.errors, '/count')
  assert.ok(name)
  assert.ok(count)
  assert.equal(name.expected, 'string')
  assert.equal(name.message, '类型必须是字符串。')
  assert.equal(count.expected, 'integer')
  assert.equal(count.message, '类型必须是整数。')
})

test('schema errors cap at 50 entries after expanding required properties', () => {
  const keys = Array.from({ length: 60 }, (_, index) => `field${index}`)
  const schema = Type.Object(Object.fromEntries(keys.map((key) => [key, Type.String()])))
  const result = validate(schema, {})
  assert.equal(result.accepted, false)
  assert.equal(result.errors.length, MAX_GATE_ERRORS)
  assert.equal(new Set(result.errors.map((error) => error.path)).size, MAX_GATE_ERRORS)
  assert.equal(errorByPath(result.errors, '/field0')?.message, '缺少必填字段 field0。')
  assert.ok(errorByPath(result.errors, '/field49'))
  assert.equal(errorByPath(result.errors, '/field50'), undefined)
  assert.equal(errorByPath(result.errors, '/field59'), undefined)
})

test('schema errors cap additionalProperties expansion at 50 without keeping later extra fields', () => {
  const extraKeys = Array.from({ length: 60 }, (_, index) => `extra${index}`)
  const schema = Type.Object({ keep: Type.String() }, { additionalProperties: false })
  const output = Object.fromEntries([['keep', 'ok'], ...extraKeys.map((key, index) => [key, index])])
  const result = validate(schema, output)
  assert.equal(result.accepted, false)
  assert.equal(result.errors.length, MAX_GATE_ERRORS)
  assert.equal(new Set(result.errors.map((error) => error.path)).size, MAX_GATE_ERRORS)
  assert.equal(errorByPath(result.errors, '/extra0')?.message, '不允许额外字段 extra0。')
  assert.ok(errorByPath(result.errors, '/extra49'))
  assert.equal(errorByPath(result.errors, '/extra50'), undefined)
  assert.equal(errorByPath(result.errors, '/extra59'), undefined)
  assert.equal(result.errors.some((error) => error.path === '/keep' || error.path === '/'), false)
})

test('schema errors keep the original message for other keywords', () => {
  const schema = Type.Object({ name: Type.String({ pattern: '^[a-z]+$' }) })
  const output = { name: '123' }
  const raw = Value.Errors(schema, output).find((error) => error.keyword === 'pattern')
  assert.ok(raw)
  const result = validate(schema, output)
  assert.equal(result.accepted, false)
  const error = errorByPath(result.errors, '/name')
  assert.ok(error)
  assert.equal(error.code, 'SCHEMA_INVALID')
  assert.equal(error.message, raw.message)
  assert.equal(error.expected, undefined)
})

test('schema errors describe minItems, maxItems and maxLength in Chinese', () => {
  const schema = Type.Object({
    items: Type.Array(Type.String({ maxLength: 3 }), { minItems: 2, maxItems: 3 }),
  })
  const tooFew = validate(schema, { items: ['ab'] })
  assert.equal(errorByPath(tooFew.errors, '/items')?.message, '至少需要 2 项。')
  assert.equal(errorByPath(tooFew.errors, '/items')?.expected, '2')

  const tooMany = validate(schema, { items: ['ab', 'cd', 'ef', 'gh'] })
  assert.equal(errorByPath(tooMany.errors, '/items')?.message, '最多允许 3 项。')
  assert.equal(errorByPath(tooMany.errors, '/items')?.expected, '3')

  const tooLong = validate(schema, { items: ['abcd', 'ef'] })
  assert.equal(errorByPath(tooLong.errors, '/items/0')?.message, '长度不能超过 3 个字符。')
  assert.equal(errorByPath(tooLong.errors, '/items/0')?.expected, '3')
})

test('schema errors do not present a truncated path as a complete field', () => {
  const longParent = 'p'.repeat(220)
  const nested = validate(
    Type.Object({ [longParent]: Type.Object({ child: Type.String() }) }),
    { [longParent]: {} },
  )
  const nestedError = nested.errors[0]
  assert.ok(nestedError)
  assert.ok(nestedError.path.length <= 200)
  assert.equal(nestedError.path.includes('…'), true)
  assert.equal(nestedError.path.endsWith('/child'), true)
  assert.equal(nestedError.path.endsWith(`/${longParent}`), false)

  const longField = 'field'.repeat(50)
  const longFieldError = validate(Type.Object({ [longField]: Type.String() }), {}).errors[0]
  assert.ok(longFieldError)
  assert.equal(longFieldError.path.length, 200)
  assert.equal(longFieldError.path.endsWith('…'), true)
  assert.equal(longFieldError.path.endsWith(longField), false)
  assert.equal(longFieldError.path === `/${longField}`, false)
})
