export interface ReportInsightSection {
  id: string
  label: string
}

export interface ReportInsightOutput {
  title: string
  summary: string
  readingMinutes: number
  sections: ReportInsightSection[]
  html: string
}
