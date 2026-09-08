import { stat } from 'node:fs/promises'
import mammoth from 'mammoth'
import { runtimeConfig } from '@/lib/config/environment'
import { validateDocxArchive } from './report-storage'

const maxUploadBytes = runtimeConfig.report.maxUploadBytes
const maxExtractedCharacters = runtimeConfig.report.maxExtractedCharacters

async function main() {
  const filePath = process.argv[2]
  if (!filePath) throw new Error('缺少 DOCX 文件路径。')
  const details = await stat(filePath)
  if (!details.isFile()) throw new Error('DOCX 文件不是常规文件。')
  const fileSize = Number(details.size)
  if (fileSize > maxUploadBytes) throw new Error('DOCX 文件超过 ' + maxUploadBytes + ' 字节限制。')

  // 解压预扫和 Mammoth 都留在受限子进程中，避免压缩炸弹污染 Web/worker 主进程。
  await validateDocxArchive(filePath, fileSize)
  const result = await mammoth.extractRawText({ path: filePath })
  const extracted = createExtractedText(result.value)
  writeResult({ ok: true, ...extracted })
}

function createExtractedText(rawText: string) {
  if (rawText.length > maxExtractedCharacters) throw new Error('DOCX 提取后的正文超过字符限制。')
  const paragraphs = rawText.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  const text = paragraphs.join('\n')
  if (!text) throw new Error('DOCX 未提取出可用正文。')
  if (text.length > maxExtractedCharacters) throw new Error('DOCX 提取后的正文超过字符限制。')
  return { text, paragraphCount: paragraphs.length, characterCount: text.length }
}

function writeResult(result: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(result) + '\n')
}

void main().catch((error) => {
  writeResult({ ok: false, error: error instanceof Error ? error.message : 'DOCX 解析失败。' })
  process.exitCode = 1
})
