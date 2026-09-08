import { isDocumentParseError } from '@/lib/documents/document-parser'
import { createAnalysisEventPublisher, createAnalysisRepository } from '@/lib/db/analysis-repository'
import { runAnalysisPipeline } from '@/modules/analysis/pipeline'
import { processInsightJob } from '@/worker/insight-processor'
import { ensureReportSourceFile, isPermanentReportSourceError, isReportSourceError } from '@/worker/report-source'

export async function processJob(jobId: string, options: { signal?: AbortSignal; leaseOwner?: string } = {}) {
  const repository = createAnalysisRepository(options.leaseOwner)
  const publisher = createAnalysisEventPublisher(options.leaseOwner)
  let reportId: string | undefined
  let jobType: string | undefined
  try {
    const job = repository.getJob(jobId)
    if (!job) throw new Error(`Unknown job: ${jobId}`)
    reportId = job.reportVersionId
    jobType = job.type
    if (job.type === 'insight') {
      return await processInsightJob(jobId, options)
    }
    const report = repository.getReport(job.reportVersionId)
    if (!report) throw new Error('分析任务关联的报告版本不存在。')
    await ensureReportSource(jobId, repository, options.signal, job, report)
    await runAnalysisPipeline({
      jobId,
      reportVersionId: job.reportVersionId,
      repository,
      publisher,
      signal: options.signal,
      leaseOwner: options.leaseOwner,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '分析任务执行失败。'
    // AbortSignal 不是唯一的停止来源：取消请求和租约丢失都可能在下一次
    // heartbeat 之前到达。停止后的错误不能再覆盖报告解析状态或任务终态。
    const stopped = options.signal?.aborted === true || isJobStopped(repository, jobId)
    const sourceErrorCode = getReportSourceErrorCode(error)
    const permanentReportSourceFailure = isPermanentReportSourceError(error)
      || sourceErrorCode === 'ENOENT'
      || sourceErrorCode === 'ENOTDIR'
      || (error instanceof Error && /原始文件不存在/.test(error.message))
    const transientReportSourceFailure = isTransientReportSourceFailure(error, sourceErrorCode)
    const permanentDocumentParseFailure = Boolean(reportId && !transientReportSourceFailure && (
      (isDocumentParseError(error) && !isRetryableDocumentParseFailure(error))
      || permanentReportSourceFailure
    ))
    if (!stopped) {
      if (permanentDocumentParseFailure && reportId && (jobType === 'initial' || jobType === 'rerun')) {
        repository.markReportParsingFailed(reportId, message)
      }
      if (permanentDocumentParseFailure || !options.leaseOwner) {
        // 永久损坏文件不再重试；无租约的直接调用也不能重新排队。
        repository.failJob(jobId, message)
      }
    }
    throw error
  }

  return repository.getJob(jobId)
}

async function ensureReportSource(
  jobId: string,
  repository: ReturnType<typeof createAnalysisRepository>,
  signal: AbortSignal | undefined,
  job: NonNullable<ReturnType<ReturnType<typeof createAnalysisRepository>['getJob']>>,
  report: NonNullable<ReturnType<ReturnType<typeof createAnalysisRepository>['getReport']>>,
) {
  throwIfAborted(signal, repository, jobId)
  if (job.id !== jobId) throw new Error(`Unknown job: ${jobId}`)
  const source = repository.getReportSource(report.id)
  if (!source) throw new Error('报告原始文件不存在，无法提交给 AI。')
  await ensureReportSourceFile(source.path, signal)
}

const transientReportSourceErrorCodes = new Set(['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'ESTALE'])

function getReportSourceErrorCode(error: unknown) {
  if (isReportSourceError(error)) return error.code
  if (!isDocumentParseError(error)) return undefined
  if (error.code) return error.code
  return Array.from(new Set(['ENOENT', 'ENOTDIR', ...transientReportSourceErrorCodes])).find((code) => new RegExp('(?:^|\\W)' + code + '(?:$|\\W)').test(error.message))
}

function isTransientReportSourceFailure(error: unknown, code: string | undefined) {
  if (isReportSourceError(error) || isDocumentParseError(error)) return error.retryable
  return code !== undefined && transientReportSourceErrorCodes.has(code)
}

function isJobStopped(repository: ReturnType<typeof createAnalysisRepository>, jobId: string) {
  try {
    const job = repository.getJob(jobId)
    if (!job || job.status !== 'running') return true
    return repository.isCancellationRequested(jobId)
  } catch {
    // 无法确认 DB 状态时宁可放弃写入，也不能用旧错误覆盖新状态。
    return true
  }
}

export function isRetryableDocumentParseFailure(error: unknown) {
  return isDocumentParseError(error) && error.retryable
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  repository?: ReturnType<typeof createAnalysisRepository>,
  jobId?: string,
) {
  if (signal?.aborted || (repository && jobId && repository.isCancellationRequested(jobId))) throw new Error('Analysis cancelled')
}
