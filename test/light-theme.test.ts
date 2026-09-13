import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReportDocumentViewer } from '../components/report-document-viewer'
import { TopbarUserNav } from '../components/workspace-user-nav'
import { renderInsightDocument } from '../lib/rendering/markdown'

test('root layout no longer reads persisted or system theme preferences', () => {
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(layout, /yx-theme|matchMedia|localStorage|suppressHydrationWarning/)
  assert.equal(existsSync(new URL('../components/theme-toggle.tsx', import.meta.url)), false)
})

test('application styles only support the light color scheme', () => {
  const tokens = readFileSync(new URL('../app/color-tokens.css', import.meta.url), 'utf8')
  const globals = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  assert.match(tokens, /color-scheme: only light;/)
  for (const css of [tokens, globals]) {
    assert.doesNotMatch(css, /[.]dark\b|@custom-variant dark|prefers-color-scheme/)
  }
})

test('topbar keeps account controls without a theme switch', () => {
  const html = renderToStaticMarkup(createElement(TopbarUserNav, {
    onSettings() {},
    onEditProfile() {},
  }))
  assert.match(html, /账户菜单/)
  assert.doesNotMatch(html, /切换到.*模式|lucide-moon|lucide-sun/)
})

test('DOCX frame has a fixed light scheme and standalone background fallback', () => {
  const html = renderToStaticMarkup(createElement(ReportDocumentViewer, {
    report: { id: 'report-light', title: '浅色阅读', fileName: 'report.docx' },
  }))
  assert.match(html, /srcDoc=/)
  assert.match(html, /color-scheme: only light;/)
  assert.match(html, /var\(--yx-hover, #efedea\)/)
  assert.match(html, /sandbox="allow-same-origin"/)
  assert.doesNotMatch(html, /themechange|yx-docx-theme|#24231f/)
})

test('generated insight documents do not follow the operating system theme', () => {
  for (const content of ['# 洞察\n\n研究结论', '<!doctype html><html><head></head><body>研究结论</body></html>']) {
    const html = renderInsightDocument(content)
    assert.match(html, /color-scheme: only light;/)
    assert.match(html, /--color-bg: #ffffff;/)
    assert.doesNotMatch(html, /prefers-color-scheme|#1c1917;\s*--color-text: #e7e5e4/)
  }
})
