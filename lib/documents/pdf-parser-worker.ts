import { readFile, stat } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import { runtimeConfig } from '@/lib/config/environment'

const maxUploadBytes = runtimeConfig.report.maxUploadBytes
const maxExtractedCharacters = runtimeConfig.report.maxExtractedCharacters
const maxPdfPages = runtimeConfig.report.maxPdfPages
const maxParserRssBytes = runtimeConfig.report.maxPdfParserRssBytes

async function main() {
  const filePath = process.argv[2]
  if (!filePath) throw new Error('缺少 PDF 文件路径。')
  const details = await stat(filePath)
  if (!details.isFile()) throw new Error('PDF 文件不是常规文件。')
  if (Number(details.size) > maxUploadBytes) throw new Error('PDF 文件超过 ' + maxUploadBytes + ' 字节限制。')
  const parser = new PDFParse({
    data: new Uint8Array(await readFile(filePath)),
    maxImageSize: 16_000_000,
    stopAtErrors: true,
  })
  try {
    assertParserMemoryBudget()
    const info = await parser.getInfo()
    assertParserMemoryBudget()
    if (info.total > maxPdfPages) throw new Error('PDF 页数超过 ' + maxPdfPages + ' 页限制。')
    const paragraphs: string[] = []
    let characterCount = 0
    for (let pageNumber = 1; pageNumber <= info.total; pageNumber += 1) {
      const page = await parser.getText({ partial: [pageNumber], pageJoiner: '' })
      const pageText = page.pages[0]?.text ?? page.text
      characterCount = appendParagraphs(pageText, paragraphs, characterCount)
      assertParserMemoryBudget()
    }
    if (!paragraphs.length) throw new Error('PDF 未提取出可用正文。')
    writeResult({ ok: true, text: paragraphs.join('\n'), paragraphCount: paragraphs.length, characterCount })
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

function appendParagraphs(rawText: string, paragraphs: string[], characterCount: number) {
  if (rawText.length > maxExtractedCharacters - characterCount) throw new Error('PDF 提取后的正文超过字符限制。')
  for (const line of rawText.replace(/\r\n?/g, '\n').split('\n')) {
    const paragraph = line.trim()
    if (!paragraph) continue
    const nextCharacterCount = characterCount + (paragraphs.length ? 1 : 0) + paragraph.length
    if (nextCharacterCount > maxExtractedCharacters) throw new Error('PDF 提取后的正文超过字符限制。')
    paragraphs.push(paragraph)
    characterCount = nextCharacterCount
  }
  return characterCount
}

function assertParserMemoryBudget() {
  const rss = process.memoryUsage().rss
  if (rss > maxParserRssBytes) {
    throw new Error('PDF 解析进程内存超过 ' + Math.round(maxParserRssBytes / 1024 / 1024) + ' MiB 限制。')
  }
}

function writeResult(result: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(result) + '\n')
}

void main().catch((error) => {
  writeResult({ ok: false, error: error instanceof Error ? error.message : 'PDF 解析失败。' })
  process.exitCode = 1
})
