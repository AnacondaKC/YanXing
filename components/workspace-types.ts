export type KnowledgeItem = {
  id: string
  title: string
  fileName: string
  fileSize: number
  category: string
  description: string
  tags: string[]
  uploadedBy: string
  canDelete: boolean
  createdAt: string
  updatedAt: string
}
