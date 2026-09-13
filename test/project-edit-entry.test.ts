import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import test from 'node:test'
import { DashboardView } from '../components/dashboard-view'
import { ResearchWorkbench } from '../components/research-workbench'

const noop = () => {}
const workbenchProps = {
  analyzing: false,
  cancelling: false,
  report: { id: 'report-one' },
  onCancelAnalysis: async () => {},
  onStartAnalysis: noop,
  onOpenProgress: noop,
}

test('collaborators can open project configuration without gaining report actions', () => {
  const html = renderToStaticMarkup(createElement(ResearchWorkbench, {
    ...workbenchProps,
    canManage: false,
    onEditProject: noop,
  }))
  assert.match(html, /修改课题/)
  assert.doesNotMatch(html, /启动分析|课题进展|更新报告/)
})

test('read-only viewers without configuration access have no edit button', () => {
  const html = renderToStaticMarkup(createElement(ResearchWorkbench, { ...workbenchProps, canManage: false }))
  assert.doesNotMatch(html, /修改课题|启动分析|课题进展/)
})

test('owners retain independent analysis and project configuration actions', () => {
  const html = renderToStaticMarkup(createElement(ResearchWorkbench, {
    ...workbenchProps,
    canManage: true,
    onEditProject: noop,
  }))
  assert.match(html, /修改课题/)
  assert.match(html, /启动分析/)
})

test('empty dashboard removes the extra project-edit toolbar and preserves its content', () => {
  for (const emptyState of [undefined, createElement('section', null, '首份报告上传区')]) {
    const html = renderToStaticMarkup(createElement(DashboardView, {
      canManage: false,
      onCancelAnalysis: async () => {},
      onEditProject: noop,
      emptyState,
    }))
    assert.doesNotMatch(html, /修改课题|mb-3 flex shrink-0 justify-end|启动分析|更新报告/)
    assert.ok(html.includes(emptyState ? '首份报告上传区' : '当前阶段还没有报告'))
  }
})

test('workspace binds edits to the clicked project and keeps report permissions separate', () => {
  const app = readFileSync(new URL('../components/workspace-app.tsx', import.meta.url), 'utf8')
  const entry = readFileSync(new URL('../components/workspace-project-edit-entry.tsx', import.meta.url), 'utf8')
  assert.match(app, /<WorkspaceProjectEditEntry/)
  assert.match(app, /key={editProjectId}/)
  assert.match(app, /projectId={editProjectId}/)
  assert.match(app, /onEditProject={detail.project.canManage/)
  assert.match(app, /canManage={detail.project.canSubmit}/)
  assert.doesNotMatch(app, /WorkspaceProjectMetaDialog|setMetaOpen/)
  assert.ok(entry.includes('fetchWorkspaceProject(projectId, controller.signal)'))
  assert.match(entry, /controller.signal.aborted/)
  assert.match(entry, /detail.project.id !== projectId/)
})
