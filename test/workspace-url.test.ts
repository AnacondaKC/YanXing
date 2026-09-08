import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWorkspaceSearch, parseWorkspaceSearch } from '../lib/workspace-url'

test('workspace URL restores a project report view', () => {
  assert.deepEqual(parseWorkspaceSearch('?view=insight&project=project-1&report=report-2'), {
    view: 'insight',
    projectId: 'project-1',
    reportId: 'report-2',
  })
})

test('workspace URL defaults a project query to the dashboard', () => {
  assert.deepEqual(parseWorkspaceSearch('?project=project-1'), {
    view: 'dashboard',
    projectId: 'project-1',
  })
  assert.deepEqual(parseWorkspaceSearch('?view=dashboard'), {
    view: 'overview',
    projectId: '',
  })
})

test('top-level views discard stale project and report identifiers', () => {
  assert.deepEqual(parseWorkspaceSearch('?view=reports&project=project-1&report=report-2'), {
    view: 'reports',
    projectId: '',
  })
  assert.deepEqual(parseWorkspaceSearch('?view=projects'), {
    view: 'overview',
    projectId: '',
  })
})

test('workspace URL serialization keeps only relevant state', () => {
  assert.equal(buildWorkspaceSearch({ view: 'overview', projectId: '' }), '')
  assert.equal(buildWorkspaceSearch({ view: 'insight', projectId: 'project-1', reportId: 'report-2' }), '?view=insight&project=project-1&report=report-2')
  assert.equal(buildWorkspaceSearch({ view: 'reports', projectId: 'project-1', reportId: 'report-2' }), '?view=reports')
})
