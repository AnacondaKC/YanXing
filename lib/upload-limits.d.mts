export const mebibyte: number
export const reportMaxUploadBytes: number
export const knowledgeMaxUploadBytes: number
export const knowledgeMultipartOverheadBytes: number
export const proxyBodySizeProbeBytes: number

export function parsePositiveSafeInteger(raw: unknown, fallback: number): number
export function parseReportMaxUploadBytes(raw?: unknown, fallback?: number): number
export function resolveProxyClientMaxBodySize(input?: {
  reportBytes?: number
  knowledgeBytes?: number
}): number
