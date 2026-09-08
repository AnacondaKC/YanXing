import assert from 'node:assert/strict'
import test from 'node:test'

import { markdownToHtml } from '../lib/rendering/markdown'

test('blockquote does not swallow following ATX heading, list, or thematic break', () => {
  assert.equal(
    markdownToHtml('> 引用\n### 标题'),
    '<blockquote><p>引用</p></blockquote>\n<h3>标题</h3>',
  )
  assert.equal(
    markdownToHtml('> 引用\n- 列表'),
    '<blockquote><p>引用</p></blockquote>\n<ul>\n<li>列表</li>\n</ul>',
  )
  assert.equal(
    markdownToHtml('> 引用\n---'),
    '<blockquote><p>引用</p></blockquote>\n<hr />',
  )
})

test('blockquote keeps lazy paragraph continuation and quoted structures', () => {
  assert.equal(
    markdownToHtml('> 引用\n普通续行'),
    '<blockquote><p>引用</p>\n<p>普通续行</p></blockquote>',
  )
  assert.equal(
    markdownToHtml('> 引用\n\n### 标题'),
    '<blockquote><p>引用</p></blockquote>\n<h3>标题</h3>',
  )
  assert.equal(
    markdownToHtml('> ### 标题\n> - 列表'),
    '<blockquote><h3>标题</h3>\n<ul>\n<li>列表</li>\n</ul></blockquote>',
  )
})
