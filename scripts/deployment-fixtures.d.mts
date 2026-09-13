export const PDF_MIME_TYPE: 'application/pdf'
export const DOCX_MIME_TYPE: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export function createMinimalPdfBuffer(text?: string): Buffer
export function createMinimalDocxBuffer(text?: string): Buffer
export function createPreviewableDocxBuffer(text?: string): Buffer
