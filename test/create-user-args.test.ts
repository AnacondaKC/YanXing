import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCreateUserArgs } from '../scripts/create-user'

test('create-user parser keeps values after extra equals signs', () => {
  const parsed = parseCreateUserArgs(['--username=admin', '--display-name=A=B=C', '--password=p=w=d', '--role=admin'])
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.values.get('username'), 'admin')
  assert.equal(parsed.values.get('display-name'), 'A=B=C')
  assert.equal(parsed.values.get('password'), 'p=w=d')
  assert.equal(parsed.values.get('role'), 'admin')
})

test('create-user parser rejects missing separated values without consuming the next flag', () => {
  const missing = parseCreateUserArgs(['--username', '--password', 'secret'])
  assert.equal(missing.error, '参数 --username 缺少值。')
  assert.equal(missing.values.has('password'), false)

  const trailing = parseCreateUserArgs(['--username', 'admin', '--password'])
  assert.equal(trailing.error, '参数 --password 缺少值。')
  assert.equal(trailing.values.get('username'), 'admin')
  assert.equal(trailing.values.has('password'), false)
})

test('create-user parser accepts separated values and empty attached values', () => {
  const separated = parseCreateUserArgs(['--username', 'admin', '--password', 'secret'])
  assert.equal(separated.error, undefined)
  assert.equal(separated.values.get('username'), 'admin')
  assert.equal(separated.values.get('password'), 'secret')

  const empty = parseCreateUserArgs(['--password='])
  assert.equal(empty.error, undefined)
  assert.equal(empty.values.get('password'), '')
})
