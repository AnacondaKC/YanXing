import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement, lazy, Suspense, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { WorkspaceDialogLoading } from '../components/workspace-dialog-loading'
import {
  createRetryableSettingsPanel,
  SettingsPanelLoadError,
  SettingsPanelLoading,
  settingsPanelStatusCopy,
} from '../components/retryable-settings-panel'

const dashboard = readFileSync(new URL('../components/dashboard.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../components/admin-settings.tsx', import.meta.url), 'utf8')
const retryablePanel = readFileSync(new URL('../components/retryable-settings-panel.tsx', import.meta.url), 'utf8')
const topbar = readFileSync(new URL('../components/workspace-user-nav.tsx', import.meta.url), 'utf8')
const optionalPanels = ['AdminModelSettings', 'AiBudgetSettingsPanel', 'BrandingSettingsPanel', 'UserManagementSettings', 'PromptSettings'] as const

test('cold dialog suspension is contained inside the workspace rather than replacing it', () => {
  const source = ts.createSourceFile('dashboard.tsx', dashboard, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let foundDialog = false
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'WorkspaceDialogs') {
      foundDialog = true
      assert.ok(ts.isJsxElement(node.parent))
      assert.equal(node.parent.openingElement.tagName.getText(source), 'Suspense')
      assert.match(node.parent.openingElement.getText(source), /fallback={<WorkspaceDialogLoading/)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(foundDialog)
})

test('cold settings loading preserves workspace content and supplies a named closable dialog', () => {
  const PendingDialog = lazy(() => new Promise<never>(() => {}))
  const html = renderToStaticMarkup(createElement('main', null,
    createElement('section', null, '工作台内容'),
    createElement(Suspense, { fallback: createElement(WorkspaceDialogLoading, { onClose() {} }) }, createElement(PendingDialog)),
  ))
  assert.match(html, /工作台内容/)
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-label="主要设置"/)
  assert.match(html, /aria-label="关闭设置"/)
  assert.match(html, /role="status"/)
  assert.match(html, /正在载入设置/)
})

test('other workspace dialogs show nonblocking loading feedback', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceDialogLoading))
  assert.match(html, /role="status"/)
  assert.doesNotMatch(html, /role="dialog"/)
})

test('optional settings pages have local retryable lazy boundaries and are not eager imports', () => {
  assert.ok(!settings.includes('next/dynamic'))
  assert.ok(settings.includes("from '@/components/retryable-settings-panel'"))
  assert.match(settings, /import { ProjectManagementSettings }/)
  for (const name of optionalPanels) {
    assert.ok(settings.includes('const ' + name + ' = createRetryableSettingsPanel('), name + ' must load on demand')
    assert.ok(!settings.includes('import { ' + name + ' }'))
  }
})

test('retryable settings panel factory creates a fresh lazy instance after failure', () => {
  assert.ok(!retryablePanel.includes('next/dynamic'))
  assert.ok(retryablePanel.includes('lazy(() => resource.load().then'))
  assert.ok(retryablePanel.includes("snapshot.status === 'loaded'"))
  assert.ok(retryablePanel.includes('snapshot.value'))
  assert.ok(retryablePanel.includes('<Suspense fallback={<SettingsPanelLoading'))
  assert.ok(retryablePanel.includes('SettingsPanelErrorBoundary key={generation}'))
  assert.ok(retryablePanel.includes('setGeneration((current) => current + 1)'))
  assert.ok(retryablePanel.includes('hasError'))
  assert.ok(retryablePanel.includes('getDerivedStateFromError'))
})

test('settings panel loading and error copy stay local and in Chinese', () => {
  const loading = renderToStaticMarkup(createElement(SettingsPanelLoading))
  assert.match(loading, /role="status"/)
  assert.match(loading, new RegExp(settingsPanelStatusCopy.loading))
  const failed = renderToStaticMarkup(createElement(SettingsPanelLoadError, { onRetry() {} }))
  assert.match(failed, /role="alert"/)
  assert.match(failed, new RegExp(settingsPanelStatusCopy.failed))
  assert.match(failed, new RegExp(settingsPanelStatusCopy.retry))
  assert.doesNotMatch(failed, /role="dialog"/)
})

test('pending retryable settings panel suspends into the local loading status', () => {
  const PendingPanel = createRetryableSettingsPanel(() => new Promise<ComponentType<object>>(() => {}))
  const html = renderToStaticMarkup(createElement(PendingPanel))
  assert.match(html, /role="status"/)
  assert.match(html, new RegExp(settingsPanelStatusCopy.loading))
  assert.doesNotMatch(html, /role="dialog"/)
  assert.doesNotMatch(html, new RegExp(settingsPanelStatusCopy.failed))
})

test('settings preloads on idle, pointer intent and keyboard focus', () => {
  assert.ok(dashboard.includes('window.requestIdleCallback(preloadWorkspaceDialogs'))
  assert.ok(dashboard.includes('window.cancelIdleCallback(idleId)'))
  assert.ok(dashboard.includes('window.clearTimeout(timer)'))
  assert.ok(dashboard.includes('onSettingsIntent={preloadWorkspaceDialogs}'))
  for (const event of ['onPointerEnter', 'onFocus', 'onPointerDown']) {
    assert.ok(topbar.includes(event + '={onSettingsIntent}'))
  }
})
