import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchWorkspaceProject } from '../lib/workspace-submission-client'

const selectionCases = [
  {
    name: 'serializes and encodes explicit stageId and reportId API parameters',
    projectId: 'project/id',
    selection: { stageId: 'stage /+?&研究', reportId: 'report/one?&' },
    expected: '/api/projects/project%2Fid?stageId=stage+%2F%2B%3F%26%E7%A0%94%E7%A9%B6&reportId=report%2Fone%3F%26',
  },
  {
    name: 'preserves an explicit empty-stage selection without a report',
    projectId: 'project-id',
    selection: { stageId: 'empty-stage' },
    expected: '/api/projects/project-id?stageId=empty-stage',
  },
  {
    name: 'omits selection parameters for the default project view',
    projectId: 'project-id',
    selection: undefined,
    expected: '/api/projects/project-id',
  },
]

for (const scenario of selectionCases) {
  test(`fetchWorkspaceProject ${scenario.name}`, async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return Response.json({})
    }
    try {
      await fetchWorkspaceProject(scenario.projectId, undefined, scenario.selection)
      assert.deepEqual(requests, [scenario.expected])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}
