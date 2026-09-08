import { parseReportMaxUploadBytes, reportMaxUploadBytes, resolveProxyClientMaxBodySize } from './lib/upload-limits.mjs'

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.YANXING_NEXT_DIST_DIR ?? '.next',
  allowedDevOrigins: ['127.0.0.1', 'yanxing.iniko.cc'],
  serverExternalPackages: ['pdf-parse'],
  devIndicators: false,
  experimental: {
    proxyClientMaxBodySize: resolveProxyClientMaxBodySize({
      reportBytes: parseReportMaxUploadBytes(process.env.REPORT_MAX_UPLOAD_BYTES, reportMaxUploadBytes),
    }),
  },
  webpack: (config, { dev }) => {
    if (!dev) return config
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/node_modules/**', '**/.git/**', '**/.next/**', '**/.next-dev/**', '**/storage/**', '**/*.sqlite*', '**/*.log'],
    }
    return config
  },
}

export default nextConfig
