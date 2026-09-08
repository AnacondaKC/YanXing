const INSIGHT_TYPOGRAPHY_STYLES = `
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --color-bg: #ffffff;
  --color-text: #1c1917;
  --color-text-muted: #57534e;
  --color-heading: #0c0a09;
  --color-brand: #1b6e52;
  --color-brand-soft: #eef5f1;
  --color-line: #e7e5e4;
  --color-surface: #fafaf9;
  --color-code-bg: #f5f5f4;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #1c1917;
    --color-text: #e7e5e4;
    --color-text-muted: #a8a29e;
    --color-heading: #fafaf9;
    --color-brand: #3d8f6e;
    --color-brand-soft: rgba(61, 143, 110, 0.16);
    --color-line: #292524;
    --color-surface: #292524;
    --color-code-bg: #292524;
  }
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background-color: var(--color-bg);
  color: var(--color-text);
  line-height: 1.8;
  font-size: 15px;
  padding: 32px 28px;
  max-width: 900px;
  margin: 0 auto;
  word-break: break-word;
}

h1, h2, h3, h4, h5, h6 {
  color: var(--color-heading);
  font-weight: 700;
  line-height: 1.35;
  margin-top: 1.6em;
  margin-bottom: 0.6em;
}

h1:first-child, h2:first-child, h3:first-child {
  margin-top: 0;
}

h1 { font-size: 24px; border-bottom: 1px solid var(--color-line); padding-bottom: 10px; }
h2 { font-size: 20px; border-bottom: 1px solid var(--color-line); padding-bottom: 6px; }
h3 { font-size: 17px; }
h4 { font-size: 15px; }

p {
  margin-top: 0.8em;
  margin-bottom: 0.8em;
}

strong {
  font-weight: 700;
  color: var(--color-heading);
}

em {
  font-style: italic;
}

blockquote {
  border-left: 4px solid var(--color-brand);
  background: var(--color-brand-soft);
  color: var(--color-text);
  padding: 12px 18px;
  margin: 1.2em 0;
  border-radius: 0 8px 8px 0;
}

blockquote p {
  margin: 0.4em 0;
}

blockquote p:first-child { margin-top: 0; }
blockquote p:last-child { margin-bottom: 0; }

ul, ol {
  padding-left: 24px;
  margin: 0.8em 0;
}

li {
  margin: 0.35em 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.2em 0;
  font-size: 14px;
}

th, td {
  border: 1px solid var(--color-line);
  padding: 10px 14px;
  text-align: left;
}

th {
  background: var(--color-surface);
  font-weight: 600;
  color: var(--color-heading);
}

tr:nth-child(even) {
  background: var(--color-surface);
}

code {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--color-code-bg);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--color-brand);
}

pre {
  background: var(--color-code-bg);
  border: 1px solid var(--color-line);
  border-radius: 8px;
  padding: 14px 18px;
  overflow-x: auto;
  margin: 1.2em 0;
}

pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 13px;
}

hr {
  border: 0;
  border-top: 1px solid var(--color-line);
  margin: 2em 0;
}

a {
  color: var(--color-brand);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
`

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function findHtmlTagEnd(html: string, start: number) {
  let quote = ''
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function preserveHtmlTags(text: string) {
  const tags: string[] = []
  let tokenizedText = ''
  let cursor = 0
  while (cursor < text.length) {
    const tagStart = text.indexOf('<', cursor)
    if (tagStart < 0) {
      tokenizedText += text.slice(cursor)
      break
    }
    tokenizedText += text.slice(cursor, tagStart)
    const tagEnd = findHtmlTagEnd(text, tagStart + 1)
    if (tagEnd < 0) {
      tokenizedText += text.slice(tagStart)
      break
    }
    tokenizedText += `\u0000${tags.length}\u0000`
    tags.push(text.slice(tagStart, tagEnd + 1))
    cursor = tagEnd + 1
  }
  return { text: tokenizedText, tags }
}

function restoreHtmlTags(text: string, tags: string[]) {
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => tags[Number(index)] ?? '')
}

function isHtmlFragmentLine(line: string) {
  return line.trimStart().startsWith('<')
}

function isMarkdownStructuralBlockStart(trimmed: string) {
  return /^(#{1,6})\s+(.+)$/.test(trimmed)
    || /^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)
    || /^[-*+]\s+(.+)$/.test(trimmed)
    || /^\d+\.\s+(.+)$/.test(trimmed)
}

function applyInlineEmphasis(text: string) {
  let result = text
  result = result.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  result = result.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>')
  result = result.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return result
}

function parseInlineMarkdown(text: string): string {
  const preserved = preserveHtmlTags(text)
  let result = escapeHtml(preserved.text)
  const generated: string[] = []
  const stashGenerated = (html: string) => {
    generated.push(html)
    return `\u0001${generated.length - 1}\u0001`
  }

  result = result.replace(/`([^`]+)`/g, (_match, code) => stashGenerated(`<code>${code}</code>`))
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => (
    stashGenerated(`<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;" />`)
  ))
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => (
    stashGenerated(`<a href="${href}" target="_blank" rel="noopener noreferrer">${applyInlineEmphasis(label)}</a>`)
  ))
  result = applyInlineEmphasis(result)
  result = result.replace(/\u0001(\d+)\u0001/g, (_match, index) => generated[Number(index)] ?? '')

  return restoreHtmlTags(result, preserved.tags)
}

/** 将 Markdown 转为 HTML，并原样保留其中的 HTML 标签。 */
export function markdownToHtml(markdown: string): string {
  let content = markdown.trim()
  const fenceMatch = content.match(/^```(?:markdown|md|html)?\s*\n([\s\S]*?)\n```$/i)
  if (fenceMatch) {
    content = fenceMatch[1].trim()
  }

  const lines = content.split(/\r?\n/)
  const output: string[] = []

  let inCodeBlock = false
  let codeBlockLang = ''
  let codeBlockLines: string[] = []

  let inBlockquote = false
  let blockquoteLines: string[] = []

  let inList: 'ul' | 'ol' | null = null
  let listItems: string[] = []

  let inTable = false
  let tableHeader: string[] = []
  let tableRows: string[][] = []

  function flushCodeBlock() {
    if (!inCodeBlock) return
    const code = escapeHtml(codeBlockLines.join('\n'))
    const langClass = codeBlockLang ? ` class="language-${escapeHtml(codeBlockLang)}"` : ''
    output.push(`<pre><code${langClass}>${code}</code></pre>`)
    inCodeBlock = false
    codeBlockLang = ''
    codeBlockLines = []
  }

  function flushBlockquote() {
    if (!inBlockquote) return
    const innerHtml = markdownToHtml(blockquoteLines.join('\n'))
    output.push(`<blockquote>${innerHtml}</blockquote>`)
    inBlockquote = false
    blockquoteLines = []
  }

  function flushList() {
    if (!inList) return
    const itemsHtml = listItems.map((item) => `<li>${parseInlineMarkdown(item)}</li>`).join('\n')
    output.push(`<${inList}>\n${itemsHtml}\n</${inList}>`)
    inList = null
    listItems = []
  }

  function flushTable() {
    if (!inTable) return
    const thead = tableHeader.length
      ? `<thead><tr>${tableHeader.map((th) => `<th>${parseInlineMarkdown(th)}</th>`).join('')}</tr></thead>`
      : ''
    const tbody = tableRows.length
      ? `<tbody>${tableRows.map((row) => `<tr>${row.map((td) => `<td>${parseInlineMarkdown(td)}</td>`).join('')}</tr>`).join('')}</tbody>`
      : ''
    output.push(`<table>${thead}${tbody}</table>`)
    inTable = false
    tableHeader = []
    tableRows = []
  }

  function flushAll() {
    flushCodeBlock()
    flushBlockquote()
    flushList()
    flushTable()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock()
      } else {
        flushAll()
        inCodeBlock = true
        codeBlockLang = trimmed.slice(3).trim()
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    if (trimmed.startsWith('>')) {
      flushCodeBlock()
      flushList()
      flushTable()
      inBlockquote = true
      blockquoteLines.push(trimmed.replace(/^>\s?/, ''))
      continue
    } else if (inBlockquote) {
      if (!trimmed) {
        flushBlockquote()
        continue
      }
      if (!isMarkdownStructuralBlockStart(trimmed)) {
        blockquoteLines.push(trimmed)
        continue
      }
      flushBlockquote()
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())

      const isSeparator = cells.every((cell) => /^:?-+:?$/.test(cell))
      if (isSeparator) continue

      if (!inTable) {
        flushAll()
        inTable = true
        tableHeader = cells
      } else {
        tableRows.push(cells)
      }
      continue
    } else if (inTable) {
      flushTable()
    }

    if (isHtmlFragmentLine(line)) {
      flushAll()
      const block = [line]
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (!next.trim() || isHtmlFragmentLine(next)) {
          block.push(next)
          i += 1
          continue
        }
        break
      }
      output.push(parseInlineMarkdown(block.join('\n')))
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      flushAll()
      const level = headingMatch[1].length
      const text = parseInlineMarkdown(headingMatch[2].trim())
      output.push(`<h${level}>${text}</h${level}>`)
      continue
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      flushAll()
      output.push('<hr />')
      continue
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/)
    if (ulMatch) {
      if (inList !== 'ul') {
        flushAll()
        inList = 'ul'
      }
      listItems.push(ulMatch[1])
      continue
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/)
    if (olMatch) {
      if (inList !== 'ol') {
        flushAll()
        inList = 'ol'
      }
      listItems.push(olMatch[1])
      continue
    }

    if (inList) flushList()
    if (!trimmed) continue
    output.push(`<p>${parseInlineMarkdown(trimmed)}</p>`)
  }

  flushAll()
  return output.join('\n')
}

function isCompleteHtmlDocument(content: string): boolean {
  const trimmed = content.trim().toLowerCase()
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')
}

function withTypographyStyles(html: string) {
  if (/<style\b[^>]*>/i.test(html)) return html
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n<style>${INSIGHT_TYPOGRAPHY_STYLES}</style>`)
  }
  return `<style>${INSIGHT_TYPOGRAPHY_STYLES}</style>\n${html}`
}

/** 将模型输出的 Markdown + HTML 混排内容包装为可阅读文档，原样保留 HTML。 */
export function renderInsightDocument(rawContent: string): string {
  const trimmed = rawContent.trim()
  if (!trimmed) return ''

  if (isCompleteHtmlDocument(trimmed)) return withTypographyStyles(trimmed)

  const bodyHtml = markdownToHtml(trimmed)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
${INSIGHT_TYPOGRAPHY_STYLES}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}
