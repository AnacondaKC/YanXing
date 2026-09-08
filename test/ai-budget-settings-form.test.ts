import assert from 'node:assert/strict'
import test from 'node:test'
import type { AiBudgetSettings } from '../lib/ai/budget-settings'
import {
  budgetSettingsToDraft,
  parseBudgetTokens,
  validateBudgetDraft,
} from '../components/admin/ai-budget-settings-form'

const settings: AiBudgetSettings = {
  revision: 3,
  dailyTokens: 500_000,
  sevenDayTokens: Number.MAX_SAFE_INTEGER,
  updatedAt: null,
  updatedBy: null,
}

test('budget token inputs accept positive safe integers without precision loss', () => {
  for (const tokens of [1, 12, 500_000, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseBudgetTokens(String(tokens)), tokens)
  }
  assert.equal(parseBudgetTokens('00012'), 12)
  assert.equal(parseBudgetTokens('0009007199254740991'), Number.MAX_SAFE_INTEGER)
})

test('budget token inputs reject zero, fractions, non-decimal syntax and unsafe values', () => {
  const invalidValues = [
    '', '0', '000', '-1', '1.1', '1.0', '.1', '1.', '1e6', '0x10', '+1',
    'NaN', 'Infinity', ' 1 ', '1\n', '1\r\n', '\t1', '1,000', '1_000', '１２', '9007199254740992',
    '9007199254740993', '9'.repeat(400),
  ]
  for (const value of invalidValues) assert.equal(parseBudgetTokens(value), null, value)
})

test('settings drafts round-trip exactly two token limits without metadata or precision loss', () => {
  const draft = budgetSettingsToDraft(settings)
  assert.deepEqual(draft, {
    dailyTokens: '500000',
    sevenDayTokens: '9007199254740991',
  })
  assert.deepEqual(validateBudgetDraft(draft), {
    limits: {
      dailyTokens: settings.dailyTokens,
      sevenDayTokens: settings.sevenDayTokens,
    },
    errors: {},
  })
})

test('each invalid field prevents a partial save and leaves the source draft unchanged', () => {
  const draft = Object.freeze(budgetSettingsToDraft(settings))
  for (const field of ['dailyTokens', 'sevenDayTokens'] as const) {
    for (const value of ['', '0', '1.5', '9007199254740992']) {
      const result = validateBudgetDraft({ ...draft, [field]: value })
      assert.equal(result.limits, null)
      assert.deepEqual(Object.keys(result.errors), [field])
      assert.match(result.errors[field]!, /1 至 9007199254740991 的整数/)
      assert.equal(draft[field], budgetSettingsToDraft(settings)[field])
    }
  }
})

test('two empty token fields each expose their own error', () => {
  const invalid = validateBudgetDraft({ dailyTokens: '', sevenDayTokens: '' })
  assert.equal(invalid.limits, null)
  assert.deepEqual(Object.keys(invalid.errors), ['dailyTokens', 'sevenDayTokens'])
})

test('token limits are independent and normalize leading zeroes for dirty comparison', () => {
  assert.deepEqual(validateBudgetDraft({ dailyTokens: '00012', sevenDayTokens: '00001' }), {
    limits: { dailyTokens: 12, sevenDayTokens: 1 },
    errors: {},
  })
})

test('save payload includes only normalized token limits alongside the current revision', () => {
  const result = validateBudgetDraft(budgetSettingsToDraft(settings))
  assert.deepEqual(JSON.parse(JSON.stringify({ revision: settings.revision, limits: result.limits })), {
    revision: 3,
    limits: { dailyTokens: 500_000, sevenDayTokens: Number.MAX_SAFE_INTEGER },
  })
})
