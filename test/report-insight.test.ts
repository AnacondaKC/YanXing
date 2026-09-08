import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createReportInsightOutput, runReportInsightAgent } from '../lib/ai/report-insight-agent'
import type { ModelRuntime } from '../lib/ai/model-router'
import type { AnalysisPromptConfig } from '../modules/contracts/analysis'
import { ChatCompletionsError } from '../lib/ai/runtime/errors'
import { ModelUsageIncompleteError } from '../lib/ai/usage'

const directory = await mkdtemp(`${tmpdir()}/yanxing-insight-agent-`)
const environment = process.env as Record<string, string | undefined>
const originalNodeEnv = environment.NODE_ENV
environment.NODE_ENV = 'development'
environment.YANXING_DATABASE_PATH = path.join(directory, 'insight-agent.sqlite')
const { migrateDatabase } = await import('../lib/db/client')
migrateDatabase()
const insightFilePath = path.join(directory, 'report.docx')
await writeFile(`${insightFilePath}.content.json`, JSON.stringify({
  text: '报告正文内容。',
  paragraphCount: 1,
  characterCount: 7,
}))

const insightRuntime: ModelRuntime = {
  primary: {
    id: 'insight-model',
    provider: 'chat_completions',
    baseUrl: 'http://127.0.0.1/v1',
    maxContextCharacters: 10_000,
    maxOutputTokens: 4_096,
  },
  apiKey: 'test-key',
  maxContextCharacters: 10_000,
}

const insightPromptConfig: AnalysisPromptConfig = {
  target: 'report_insight',
  systemPrompt: 'system',
  instructionPrompt: 'instruction',
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'test',
}

test.after(async () => {
  await rm(directory, { recursive: true, force: true })
  if (originalNodeEnv === undefined) delete environment.NODE_ENV
  else environment.NODE_ENV = originalNodeEnv
})


test('report insight records complete token usage before deriving output metadata', async () => {
  const originalFetch = globalThis.fetch
  let completed: { provider: string; model: string; tokens: number } | undefined
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '<h1>洞察</h1><p>正文。</p>' } }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  }), { status: 200 })

  try {
    const output = await runReportInsightAgent({
      promptConfig: insightPromptConfig,
      file: { path: insightFilePath },
      runtime: insightRuntime,
      onCallCompleted: (details) => {
        completed = details
      },
    })
    assert.deepEqual(completed, {
      provider: 'chat_completions',
      model: 'insight-model',
      tokens: 5,
    })
    assert.equal(output.tokens, 5)
    assert.equal(output.title, '洞察')
    assert.equal(output.html, '<h1>洞察</h1><p>正文。</p>')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('report insight records token usage even when output parsing rejects the HTML', async () => {
  const originalFetch = globalThis.fetch
  let completedCalls = 0
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(2_000_001) } }],
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
  }), { status: 200 })

  try {
    await assert.rejects(
      () => runReportInsightAgent({
        promptConfig: insightPromptConfig,
        file: { path: insightFilePath },
        runtime: insightRuntime,
        onCallCompleted: () => {
          completedCalls += 1
        },
      }),
      (error: unknown) => error instanceof ChatCompletionsError
        && /洞察内容超过 2000000 字符上限/.test(error.message)
        && error.usage?.totalTokens === 10
        && error.provider === 'chat_completions'
        && error.model === 'insight-model',
    )
    assert.equal(completedCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('report insight does not record incomplete provider token usage', async () => {
  const originalFetch = globalThis.fetch
  let completedCalls = 0
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '<p>正文。</p>' } }],
  }), { status: 200 })

  try {
    await assert.rejects(
      () => runReportInsightAgent({
        promptConfig: insightPromptConfig,
        file: { path: insightFilePath },
        runtime: insightRuntime,
        onCallCompleted: () => {
          completedCalls += 1
        },
      }),
      ModelUsageIncompleteError,
    )
    assert.equal(completedCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('report insight preserves complete model HTML while deriving metadata', () => {
  const modelHtml = '<!doctype html><html><head><title>自定义页面</title><style>body{color:green}</style></head><body><article data-layout="custom"><h1>测试洞察</h1><blockquote>这是摘要。</blockquote><section id="conclusion"><h2>核心结论</h2><p>正文结论。</p></section></article></body></html>  '
  const output = createReportInsightOutput(modelHtml)

  assert.equal(output.html, modelHtml.trim())
  assert.equal(output.title, '测试洞察')
  assert.equal(output.summary, '这是摘要。')
  assert.equal(output.readingMinutes, 1)
  assert.deepEqual(output.sections, [{ id: 'conclusion', label: '核心结论' }])
})

test('report insight metadata extraction stays bounded for malformed tag floods', { timeout: 2_000 }, () => {
  const output = createReportInsightOutput('<'.repeat(100_000))
  assert.equal(output.title, '报告洞察')
  assert.equal(output.sections.length, 0)
})

test('report insight HTML scan keeps comparison text and quoted greater-than attributes', () => {
  const html = '<div title="a > b">p < 0.05 且 q < 1</div><span title=\'x > y\'>尾</span>'
  const output = createReportInsightOutput(html)
  assert.equal(output.summary.includes('p < 0.05'), true)
  assert.equal(output.summary.includes('q < 1'), true)
  assert.equal(output.summary.includes('尾'), true)
  assert.equal(output.summary.includes('title'), false)
})

test('report insight named entities decode apostrophes', () => {
  const output = createReportInsightOutput('<p>It&apos;s a report &amp; draft</p>')
  assert.equal(output.summary.includes("It's a report & draft"), true)
})

test('report insight accepts arbitrary HTML without requiring the old article structure', () => {
  const modelHtml = '\n<div class="custom-report"><p>只有正文也可以直接展示。</p><script>window.example = true</script></div>\n'
  const output = createReportInsightOutput(modelHtml)

  assert.equal(output.html, modelHtml.trim())
  assert.equal(output.title, '报告洞察')
  assert.equal(output.summary, '只有正文也可以直接展示。 window.example = true')
  assert.deepEqual(output.sections, [])
})

import { markdownToHtml, renderInsightDocument } from '../lib/rendering/markdown'

test('report insight rejects an empty model response', () => {
  assert.throws(() => createReportInsightOutput('  \n\t  '), /未返回洞察内容/)
})

test('report insight derives metadata from markdown content correctly', () => {
  const markdown = '# 研究报告核心洞察\n\n> 这是一个重要的摘要段落。\n\n## 关键结论\n- **观点1**：市场正在增长。\n- **观点2**：技术持续迭代。\n'
  const output = createReportInsightOutput(markdown)

  assert.equal(output.html, markdown.trim())
  assert.equal(output.title, '研究报告核心洞察')
  assert.equal(output.summary, '这是一个重要的摘要段落。')
  assert.equal(output.readingMinutes, 1)
})

test('markdownToHtml preserves mixed HTML fragments unchanged', () => {
  const html = markdownToHtml('<script>alert(1)</script>\n[点击](javascript:alert(1))')
  assert.ok(html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('href="javascript:alert(1"'))
})

test('markdownToHtml converts markdown elements to valid HTML tags', () => {
  const markdown = `# 标题一
> 引用文字

- 列表项一
- 列表项二

| 表头1 | 表头2 |
| --- | --- |
| 单元格1 | 单元格2 |

\`\`\`typescript
const x = 1;
\`\`\`
`
  const html = markdownToHtml(markdown)
  assert.ok(html.includes('<h1>标题一</h1>'))
  assert.ok(html.includes('<blockquote>'))
  assert.ok(html.includes('<ul>'))
  assert.ok(html.includes('<li>列表项一</li>'))
  assert.ok(html.includes('<table>'))
  assert.ok(html.includes('<th>表头1</th>'))
  assert.ok(html.includes('<td>单元格1</td>'))
  assert.ok(html.includes('<pre><code class="language-typescript">const x = 1;</code></pre>'))
})

test('markdownToHtml keeps class attributes and inline HTML in markdown prose', () => {
  const markdown = '<div style="display:flex;gap:8px" class="card"><span style="color:red">重点</span></div>\n\n正文 <strong style="font-weight:700">强调</strong>。'
  const html = markdownToHtml(markdown)

  assert.ok(html.includes('<div style="display:flex;gap:8px" class="card"><span style="color:red">重点</span></div>'))
  assert.ok(html.includes('<p>正文 <strong style="font-weight:700">强调</strong>。</p>'))
})

test('createReportInsightOutput keeps the first 2000 tags and original html after the scan cap', () => {
  const tags = Array.from({ length: 2001 }, (_, index) => `<p id="p${index}">x</p>`).join('')
  const html = `<section id="overview"><h2>洞察标题</h2><blockquote>摘要</blockquote>${tags}</section>`
  const insight = createReportInsightOutput(html)
  assert.equal(insight.title, '洞察标题')
  assert.equal(insight.summary, '摘要')
  assert.equal(insight.sections[0]?.id, 'overview')
  assert.equal(insight.html.includes('id="p1999"'), true)
  assert.equal(insight.html.includes('id="p2000"'), true)
})

test('createReportInsightOutput uses the first markdown heading as title', () => {
  const mixed = '## 青银东侧项目 · 速览\n\n城投与越秀组成联合体。\n\n<div style="display:flex;gap:10px"><div style="flex:1">卡片</div></div>\n\n### 项目概况\n\n后续说明。'
  const output = createReportInsightOutput(mixed)
  assert.equal(output.title, '青银东侧项目 · 速览')
  assert.equal(output.html, mixed)
})

test('report history treats an insight-only report as unanalyzed', async () => {
  const { reportHistoryStatus } = await import('../components/report-history-view')
  const status = reportHistoryStatus({
    id: 'standalone-report',
    projectId: 'project-1',
    version: 1,
    title: '报告',
    fileName: 'report.docx',
    fileHash: 'hash',
    paragraphCount: 1,
    characterCount: 10,
    parseStatus: 'ready',
    latestJobStatus: 'completed',
    currentAnalysisId: undefined,
    hasCompletedFullAnalysis: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(status.label, '待分析')
})

test('renderInsightDocument wraps mixed markdown and HTML into a reading document', () => {
  const mixed = '## 洞察标题\n\n正文描述。\n\n<div style="display:flex;gap:8px" class="card"><span>卡片</span></div>'
  const documentHtml = renderInsightDocument(mixed)
  assert.ok(documentHtml.startsWith('<!doctype html>'))
  assert.ok(documentHtml.includes('<style>'))
  assert.ok(documentHtml.includes('<h2>洞察标题</h2>'))
  assert.ok(documentHtml.includes('<p>正文描述。</p>'))
  assert.ok(documentHtml.includes('<div style="display:flex;gap:8px" class="card"><span>卡片</span></div>'))
})

test('markdownToHtml does not let emphasis mutate generated links, images, or code', () => {
  const html = markdownToHtml('见 [说明](https://example.com/a_b_c) 与 ![图](https://cdn.example.com/a_b.png) 以及 `a_b_c`。')
  assert.ok(html.includes('href="https://example.com/a_b_c"'))
  assert.ok(html.includes('src="https://cdn.example.com/a_b.png"'))
  assert.ok(html.includes('<code>a_b_c</code>'))
  assert.equal(html.includes('<em>b</em>'), false)
})

test('markdownToHtml still emphasizes link labels without rewriting the URL', () => {
  const html = markdownToHtml('[**加粗标签**](https://example.com/a_b_c)')
  assert.ok(html.includes('href="https://example.com/a_b_c"'))
  assert.ok(html.includes('<strong>加粗标签</strong>'))
})