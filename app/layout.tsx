import type { Metadata } from 'next'
import { connection } from 'next/server'
import { getPublicBrandSettingsOrDefault } from '@/lib/db/brand-settings-repository'
import { BrandingProvider } from '@/components/branding-provider'
import './globals.css'

export const metadata: Metadata = {
  title: '研行 YanXing｜研究报告情报台',
  description: '研行：面向研究团队管理者的研究报告情报台。'
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Read branding at request time so builds never freeze the default or an older logo.
  await connection()
  const initialSettings = getPublicBrandSettingsOrDefault()

  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased"><BrandingProvider initialSettings={initialSettings}>{children}</BrandingProvider></body>
    </html>
  )
}
