import assert from 'node:assert/strict'
import test from 'node:test'

import { nextPromptDrafts } from '../components/prompt-settings'
import type { AnalysisPromptConfig } from '../modules/contracts/analysis'

function prompt(target: AnalysisPromptConfig['target'], instructionPrompt: string): AnalysisPromptConfig {
  return {
    target,
    systemPrompt: '',
    instructionPrompt,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'tester',
  }
}

test('restoring one prompt keeps unrelated drafts and later in-flight edits', () => {
  const saved = [prompt('page_analysis', '分析默认'), prompt('report_insight', '洞察默认')]
  const submitted = [prompt('page_analysis', '分析草稿'), prompt('report_insight', '洞察草稿')]
  const current = [prompt('page_analysis', '分析草稿续写'), prompt('report_insight', '洞察草稿')]

  const restoredTarget = nextPromptDrafts({
    scope: 'page_analysis',
    currentSystem: '系统草稿',
    currentPrompts: current,
    savedSystemPrompt: '系统默认',
    savedPrompts: saved,
    submittedSystem: '系统草稿',
    submittedPrompts: submitted,
  })
  assert.equal(restoredTarget.draftSystem, '系统草稿')
  assert.equal(restoredTarget.draftPrompts.find((item) => item.target === 'page_analysis')?.instructionPrompt, '分析草稿续写')
  assert.equal(restoredTarget.draftPrompts.find((item) => item.target === 'report_insight')?.instructionPrompt, '洞察草稿')

  const restoredAll = nextPromptDrafts({
    scope: 'all',
    currentSystem: '系统草稿',
    currentPrompts: submitted,
    savedSystemPrompt: '系统默认',
    savedPrompts: saved,
    submittedSystem: '系统草稿',
    submittedPrompts: submitted,
  })
  assert.equal(restoredAll.draftSystem, '系统默认')
  assert.deepEqual(restoredAll.draftPrompts, saved)
})
