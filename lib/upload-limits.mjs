export const mebibyte = 1024 * 1024
export const reportMaxUploadBytes = 25 * mebibyte
export const knowledgeMaxUploadBytes = 20 * mebibyte
export const knowledgeMultipartOverheadBytes = mebibyte
export const proxyBodySizeProbeBytes = 1

export function parsePositiveSafeInteger(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function parseReportMaxUploadBytes(raw, fallback = reportMaxUploadBytes) {
  return parsePositiveSafeInteger(raw, fallback)
}

export function resolveProxyClientMaxBodySize({
  reportBytes = reportMaxUploadBytes,
  knowledgeBytes = knowledgeMaxUploadBytes,
} = {}) {
  return Math.max(reportBytes, knowledgeBytes + knowledgeMultipartOverheadBytes) + proxyBodySizeProbeBytes
}
