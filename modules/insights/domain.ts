export interface ReportInsightSection {
  id: string
  label: string
}

export interface ReportInsight {
  id: string
  reportVersionId: string
  title: string
  summary: string
  readingMinutes: number
  sections: ReportInsightSection[]
  html: string
  provider: string
  model: string
  generatedAt: string
  regenerationCount?: number
}

export interface ReportInsightOutput {
  title: string
  summary: string
  readingMinutes: number
  sections: ReportInsightSection[]
  html: string
}
