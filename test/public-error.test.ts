import assert from 'node:assert/strict'
import test from 'node:test'
import { publicErrorMessage } from '../lib/http/public-error'

test('publicErrorMessage keeps short Chinese business errors and hides system errors', () => {
  assert.equal(publicErrorMessage(new Error('该报告已有正在排队或执行中的分析任务。'), '失败'), '该报告已有正在排队或执行中的分析任务。')
  assert.equal(publicErrorMessage(new Error('UNIQUE constraint failed: analysis_jobs.id'), '启动分析失败。'), '启动分析失败。')
  assert.equal(publicErrorMessage(new Error('ENOENT: no such file'), '报告上传失败，请稍后重试。'), '报告上传失败，请稍后重试。')
  assert.equal(publicErrorMessage('not-an-error', '失败'), '失败')
  assert.equal(publicErrorMessage(new Error('模型输出无效，请稍后重试。'), '发生错误。'), '模型输出无效，请稍后重试。')
  assert.equal(publicErrorMessage(new Error('x'.repeat(200)), '发生错误。'), '发生错误。')
})
