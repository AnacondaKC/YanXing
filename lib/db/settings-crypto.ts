import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runtimeConfig } from '@/lib/config/environment'
import { getDatabasePath } from '@/lib/db/database-path'

function getLocalKeyPath() {
  return path.join(path.dirname(getDatabasePath()), '.settings-key')
}

function getSecretBytes() {
  const configuredSecret = runtimeConfig.settingsEncryptionKey
  if (configuredSecret) return Buffer.from(configuredSecret, 'utf8')

  const localKeyPath = getLocalKeyPath()
  mkdirSync(path.dirname(localKeyPath), { recursive: true })
  if (!existsSync(localKeyPath)) {
    try {
      writeFileSync(localKeyPath, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!existsSync(localKeyPath)) throw error
    }
  }
  return readFileSync(localKeyPath)
}

// v2：低熵口令（env 注入）通过 scrypt 派生密钥，避免被离线爆破；
// 本地 .settings-key 本身是随机 32 字节，两种来源共用同一派生函数。
// N=2^15 需 32MB 内存，Node 默认 maxmem（32MB）不够，这里显式放宽。
const scryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
// scrypt 结果按密钥来源缓存：env 密钥可能在运行期被更换（如密钥轮换演练），
// 缓存必须与来源绑定，否则换钥后仍用旧密钥解密。
let cachedScryptKey: { secretBase64: string; key: Buffer } | undefined

function getKey() {
  const secret = getSecretBytes()
  const secretBase64 = secret.toString('base64')
  if (!cachedScryptKey || cachedScryptKey.secretBase64 !== secretBase64) {
    cachedScryptKey = { secretBase64, key: scryptSync(secret, 'yanxing-settings-encryption-v2', 32, scryptOptions) }
  }
  return cachedScryptKey.key
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v2', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':')
}

export function decryptSecret(value: string | null) {
  if (!value) return undefined
  const [version, iv, tag, encrypted] = value.split(':')
  if (version !== 'v2' || !iv || !tag || !encrypted) throw new Error('无法读取已保存的 API 密钥。')
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')
}
