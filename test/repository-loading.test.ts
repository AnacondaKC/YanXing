import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileText } from 'lucide-react'
import { ReportsRepositoryWorkspace } from '../components/reports-repository'
import { KnowledgeBaseWorkspace } from '../components/knowledge-base'
import { RepositoryLoading } from '../components/repository-loading'
import { RepositoryStatCell } from '../components/ui/repository-stats'

const metric = { label: '报告数量', value: '12', unit: '份', icon: FileText, points: [1, 5, 12], trendLabel: '报告数量走势', gradientId: 'test-library-trend' }

test('library statistic loading keeps label but hides placeholder numbers and graphs', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, { ...metric, dataState: 'loading' }))
  assert.match(html, /报告数量正在加载/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /yx-repository-skeleton/)
  assert.doesNotMatch(html, />12<|role="img"/)
})

test('ready library statistics render immediately with their actual value', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, metric))
  assert.match(html, />12</)
  assert.match(html, /role="img"/)
  assert.doesNotMatch(html, /yx-repository-skeleton/)
})

test('failed initial library statistics have an unavailable state instead of fake zeros', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, { ...metric, dataState: 'error' }))
  assert.match(html, /报告数量暂时无法加载/)
  assert.doesNotMatch(html, /正在加载|yx-repository-skeleton|>12<|role="img"/)
})

test('statistic stagger is capped so additional columns do not slow down entry', () => {
  const html = renderToStaticMarkup(createElement(RepositoryStatCell, { ...metric, entranceIndex: 20 }))
  assert.match(html, /--repository-index:5/)
})

test('library loading placeholder provides a named status with decorative skeletons', () => {
  const html = renderToStaticMarkup(createElement(RepositoryLoading, { label: '知识库' }))
  assert.match(html, /role="status"/)
  assert.match(html, /aria-label="知识库正在加载"/)
  assert.match(html, /aria-hidden="true"/)
})

for (const workspace of ['reports', 'knowledge'] as const) {
  test(workspace + ' starts entry on each visit without showing false empty results', () => {
    for (let visit = 0; visit < 2; visit += 1) {
      const element = workspace === 'reports'
        ? createElement(ReportsRepositoryWorkspace, { projects: [], onOpenReport() {}, onSelectProject() {} })
        : createElement(KnowledgeBaseWorkspace, { onNotice() {} })
      const html = renderToStaticMarkup(element)
      assert.match(html, /data-enter="true"/)
      assert.match(html, /yx-repository-intro/)
      assert.match(html, /yx-repository-filters/)
      assert.match(html, /yx-repository-stat/)
      assert.match(html, /aria-busy="true"/)
      assert.doesNotMatch(html, /暂无匹配的报告|暂无参考研报|>0</)
    }
  })
}
