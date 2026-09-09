import { parseReportMaxUploadBytes, reportMaxUploadBytes, resolveProxyClientMaxBodySize } from './lib/upload-limits.mjs'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.YANXING_STANDALONE === '1' ? 'standalone' : undefined,
  outputFileTracingExcludes: process.env.YANXING_STANDALONE === '1' ? {
    '/*': [
      './storage/**/*',
      './.env*',
      './node_modules/**/tsx/**/*',
      './node_modules/**/esbuild/**/*',
      './node_modules/**/@esbuild/**/*',
      './node_modules/**/typescript/**/*',
      './node_modules/**/@next/swc-*/**/*',
      './lib/**/*.ts',
      './worker/**/*.ts',
      './scripts/**/*.ts',
    ],
  } : undefined,
  distDir: process.env.YANXING_NEXT_DIST_DIR ?? '.next',
  allowedDevOrigins: ['127.0.0.1', '192.168.7.9', 'yanxing.iniko.cc'],
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
