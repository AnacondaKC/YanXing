import { mebibyte, parseReportMaxUploadBytes, reportMaxUploadBytes } from '@/lib/upload-limits'

const NODE_MAX_TIMER_MS = 2_147_483_647

function readRaw(name: string): string | undefined {
  return process.env[name]
}

function readTrimmed(name: string): string | undefined {
  const value = readRaw(name)?.trim()
  return value || undefined
}

function readPositiveFiniteNumber(name: string, fallback: number): number {
  const parsed = Number(readRaw(name))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readPositiveInteger(name: string, fallback: number): number {
  const parsed = Number(readRaw(name))
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function readTimerMs(name: string, fallback: number): number {
  const value = readPositiveInteger(name, fallback)
  return value <= NODE_MAX_TIMER_MS ? value : fallback
}

function readIntegerAtLeast(name: string, fallback: number, minimum: number): number {
  const parsed = Number(readRaw(name))
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback
}

function readTimerMsAtLeast(name: string, fallback: number, minimum: number): number {
  const parsed = Number(readRaw(name))
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > NODE_MAX_TIMER_MS) return fallback
  return parsed
}

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = readRaw(name)
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + ' 必须是 ' + minimum + '-' + maximum + ' 的整数。')
  }
  return parsed
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = readRaw(name)?.trim()
  return value ? value === 'true' : fallback
}

export const runtimeConfig = {
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production'
  },

  get adminPassword(): string | undefined {
    return readRaw('YANXING_ADMIN_PASSWORD')
  },

  get databasePath(): string | undefined {
    return readTrimmed('YANXING_DATABASE_PATH')
  },

  get knowledgeStorageRoot(): string | undefined {
    return readTrimmed('YANXING_KNOWLEDGE_STORAGE_ROOT')
  },

  get settingsEncryptionKey(): string | undefined {
    return readRaw('YANXING_SETTINGS_ENCRYPTION_KEY')
  },

  get chatCompletions() {
    return {
      apiKey: readRaw('YANXING_CHAT_COMPLETIONS_API_KEY'),
      baseUrl: readRaw('YANXING_CHAT_COMPLETIONS_BASE_URL'),
      model: readRaw('YANXING_CHAT_COMPLETIONS_MODEL'),
    }
  },

  get proxy() {
    return {
      trustProxy: readBoolean('YANXING_TRUST_PROXY', false),
      trustedProxyHops: readPositiveInteger('YANXING_TRUSTED_PROXY_HOPS', 1),
    }
  },

  get sessionHours(): number {
    return readPositiveFiniteNumber('YANXING_SESSION_HOURS', 12)
  },

  get auth() {
    return {
      maxConcurrent: Math.min(16, readPositiveInteger('YANXING_AUTH_CONCURRENCY', 4)),
      maxQueued: Math.min(256, readPositiveInteger('YANXING_AUTH_QUEUE_LIMIT', 32)),
    }
  },

  get model() {
    return {
      callsPerMinute: readPositiveInteger('YANXING_MODEL_CALLS_PER_MINUTE', 30),
      idleTimeoutMs: readTimerMs('YANXING_MODEL_IDLE_TIMEOUT_MS', 1_200_000),
      maxContextCharacters: readRaw('YANXING_MODEL_MAX_CONTEXT_CHARACTERS'),
      maxOutputTokens: readRaw('YANXING_MODEL_MAX_OUTPUT_TOKENS'),
      maxResponseBytes: readPositiveInteger('YANXING_MODEL_MAX_RESPONSE_BYTES', 2 * mebibyte),
      reasoningEffort: readRaw('YANXING_MODEL_REASONING_EFFORT'),
    }
  },

  get ai() {
    return {
      dailyTokens: readPositiveInteger('YANXING_AI_DAILY_TOKENS', 5_000_000),
      sevenDayTokens: readPositiveInteger('YANXING_AI_SEVEN_DAY_TOKENS', 35_000_000),
      globalQueueLimit: readPositiveInteger('YANXING_AI_GLOBAL_QUEUE_LIMIT', 64),
      insightEstimatedTokens: readPositiveInteger('YANXING_AI_INSIGHT_ESTIMATED_TOKENS', 120_000),
      insightQueueLimit: readPositiveInteger('YANXING_AI_INSIGHT_QUEUE_LIMIT', 16),
      pageAnalysisEstimatedTokens: readPositiveInteger('YANXING_AI_PAGE_ANALYSIS_ESTIMATED_TOKENS', 100_000),
      projectQueueLimit: readPositiveInteger('YANXING_AI_PROJECT_QUEUE_LIMIT', 8),
      reconciliationIntervalMs: readTimerMs('YANXING_AI_RECONCILIATION_INTERVAL_MS', 30_000),
      reservationTtlMs: readPositiveInteger('YANXING_AI_RESERVATION_TTL_MS', 24 * 60 * 60 * 1000),
      userQueueLimit: readPositiveInteger('YANXING_AI_USER_QUEUE_LIMIT', 16),
    }
  },

  get report() {
    return {
      docxParseConcurrency: readPositiveInteger('REPORT_DOCX_PARSE_CONCURRENCY', 2),
      docxParseTimeoutMs: readTimerMs('REPORT_DOCX_PARSE_TIMEOUT_MS', 30_000),
      docxParserMemoryMb: readPositiveInteger('REPORT_DOCX_PARSER_MEMORY_MB', 256),
      maxArchiveEntries: readPositiveInteger('REPORT_MAX_ARCHIVE_ENTRIES', 5_000),
      maxArchiveEntryUncompressedBytes: readPositiveInteger('REPORT_MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES', 25 * mebibyte),
      maxCompressionRatio: readPositiveInteger('REPORT_MAX_COMPRESSION_RATIO', 100),
      maxExtractedCharacters: readPositiveInteger('REPORT_MAX_EXTRACTED_CHARACTERS', 1_000_000),
      maxPdfPages: readPositiveInteger('REPORT_MAX_PDF_PAGES', 500),
      maxPdfParserRssBytes: readPositiveInteger('REPORT_PDF_PARSER_MAX_RSS_BYTES', 512 * mebibyte),
      maxPdfStreamBytes: readPositiveInteger('REPORT_MAX_PDF_STREAM_BYTES', 256 * mebibyte),
      maxUncompressedBytes: readPositiveInteger('REPORT_MAX_UNCOMPRESSED_BYTES', 100 * mebibyte),
      maxUploadBytes: parseReportMaxUploadBytes(readRaw('REPORT_MAX_UPLOAD_BYTES'), reportMaxUploadBytes),
      parseQueueLimit: readPositiveInteger('REPORT_PARSE_QUEUE_LIMIT', 32),
      pdfParseConcurrency: readPositiveInteger('REPORT_PDF_PARSE_CONCURRENCY', 1),
      pdfParseTimeoutMs: readTimerMs('REPORT_PDF_PARSE_TIMEOUT_MS', 30_000),
      pdfParserMemoryMb: readPositiveInteger('REPORT_PDF_PARSER_MEMORY_MB', 256),
      uploadConcurrency: readPositiveInteger('REPORT_UPLOAD_CONCURRENCY', 4),
      uploadIdleTimeoutMs: readTimerMs('REPORT_UPLOAD_IDLE_TIMEOUT_MS', 30_000),
      uploadTotalTimeoutMs: readTimerMs('REPORT_UPLOAD_TOTAL_TIMEOUT_MS', 10 * 60_000),

    }
  },

  get knowledgeUpload() {
    return {
      concurrency: readPositiveInteger('KNOWLEDGE_UPLOAD_CONCURRENCY', 2),
      idleTimeoutMs: readTimerMs('KNOWLEDGE_UPLOAD_IDLE_TIMEOUT_MS', 30_000),
      totalTimeoutMs: readTimerMs('KNOWLEDGE_UPLOAD_TOTAL_TIMEOUT_MS', 10 * 60_000),
    }
  },

  get storage() {
    return {
      globalBytes: readPositiveInteger('YANXING_GLOBAL_STORAGE_BYTES', 50 * 1024 * 1024 * 1024),
      globalItems: readPositiveInteger('YANXING_GLOBAL_STORAGE_ITEMS', 100_000),
      maintenanceIntervalMs: readTimerMs('YANXING_STORAGE_MAINTENANCE_INTERVAL_MS', 15 * 60 * 1000),
      projectBytes: readPositiveInteger('YANXING_PROJECT_STORAGE_BYTES', 5 * 1024 * 1024 * 1024),
      projectItems: readPositiveInteger('YANXING_PROJECT_STORAGE_ITEMS', 10_000),
      reservationTtlMs: readPositiveInteger('YANXING_STORAGE_RESERVATION_TTL_MS', 15 * 60 * 1000),
      userBytes: readPositiveInteger('YANXING_USER_STORAGE_BYTES', 2 * 1024 * 1024 * 1024),
      userItems: readPositiveInteger('YANXING_USER_STORAGE_ITEMS', 5_000),
    }
  },

  get worker() {
    return {
      concurrency: readBoundedInteger('YANXING_WORKER_CONCURRENCY', 3, 1, 3),
      leaseMs: readIntegerAtLeast('YANXING_WORKER_LEASE_MS', 60_000, 4_000),
      maxAttempts: readPositiveInteger('YANXING_WORKER_MAX_ATTEMPTS', 5),
      pollMs: readTimerMsAtLeast('YANXING_WORKER_POLL_MS', 1_000, 100),
      retryBaseMs: readTimerMs('YANXING_WORKER_RETRY_BASE_MS', 5_000),
      retryMaxMs: readTimerMs('YANXING_WORKER_RETRY_MAX_MS', 5 * 60_000),
    }
  },

  get jobEventsRetentionDays(): number {
    return readPositiveInteger('YANXING_JOB_EVENTS_RETENTION_DAYS', 90)
  },
} as const
