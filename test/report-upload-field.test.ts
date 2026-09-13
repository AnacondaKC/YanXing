import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileDropzone, REPORT_FILE_ACCEPT } from '../components/ui/file-dropzone'

const onFile = () => assert.fail('Rendering the picker must not select a file')

test('an unavailable single-page picker is disabled without suggesting an upload is running', () => {
  const markup = renderToStaticMarkup(createElement(FileDropzone, { disabled: true, busy: false, onFile }))
  assert.match(markup, /aria-disabled="true"/)
  assert.match(markup, /tabindex="-1"/)
  assert.match(markup, /type="file"[^>]*disabled=""/)
  assert.match(markup, /cursor-not-allowed/)
  assert.doesNotMatch(markup, /animate-spin|cursor-wait/)
})

test('existing busy pickers retain their loading feedback', () => {
  const markup = renderToStaticMarkup(createElement(FileDropzone, { disabled: true, onFile }))
  assert.match(markup, /animate-spin/)
  assert.match(markup, /cursor-wait/)
})

test('an empty picker exposes a keyboard-accessible named action and accepted report formats', () => {
  const markup = renderToStaticMarkup(createElement(FileDropzone, { onFile }))
  assert.match(markup, /role="button"[^>]*tabindex="0"/)
  assert.match(markup, /aria-label="选择报告文件"/)
  assert.ok(markup.includes('accept="' + REPORT_FILE_ACCEPT + '"'))
  assert.doesNotMatch(markup, /animate-spin/)
})

test('selected report names remain accessible even when their visual label is truncated', () => {
  const file = new File(['report'], '完整研究报告长文件名.pdf', { type: 'application/pdf' })
  const markup = renderToStaticMarkup(createElement(FileDropzone, { file, onFile }))
  assert.ok(markup.includes('aria-label="更换报告文件：' + file.name + '"'))
  assert.ok(markup.includes('title="' + file.name + '"'))
  assert.ok(markup.includes('min-w-0 max-w-[18rem] truncate'))
  assert.match(markup, /点击可重新选择/)
})
