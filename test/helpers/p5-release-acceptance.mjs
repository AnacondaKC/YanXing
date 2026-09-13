import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const FAKE_P5_BUILD_ID = 'p5-fake-build-id'

export async function createFakeReleaseRoot(root, {
  snapshotName = '.next-p5-qa',
  buildId = FAKE_P5_BUILD_ID,
  includeRuntime = true,
  includeBackupCli = false,
} = {}) {
  const snapshotDir = path.join(root, snapshotName)
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(path.join(root, 'server.js'), '// fake standalone server.js\n')
  await writeFile(path.join(snapshotDir, 'BUILD_ID'), `${buildId}\n`)
  await writeFile(path.join(snapshotDir, 'required-server-files.json'), `{"config":{"distDir":"${snapshotName}","output":"standalone"}}\n`)
  if (includeRuntime) await writeFakeRuntime(path.join(root, '.runtime'), { includeBackupCli })
  return {
    root,
    snapshotDir,
    serverPath: path.join(root, 'server.js'),
    workerPath: path.join(root, '.runtime/worker/index.mjs'),
  }
}

export async function createFakeNextDistProject(root, {
  distDirName = '.next-p4-qa',
  buildId = 'p4-fake-build-id',
} = {}) {
  const distDir = path.join(root, distDirName)
  await mkdir(distDir, { recursive: true })
  await mkdir(path.join(root, 'node_modules/next/dist/bin'), { recursive: true })
  await writeFile(path.join(distDir, 'BUILD_ID'), `${buildId}\n`)
  await writeFile(path.join(distDir, 'required-server-files.json'), `{"config":{"distDir":"${distDirName}"}}\n`)
  await writeFile(path.join(root, 'node_modules/next/dist/bin/next'), '// fake next bin\n')
  await writeFakeRuntime(path.join(root, '.runtime'))
  return { root, distDir }
}

export async function writeFakeRuntime(runtimeRoot, { includeBackupCli = false } = {}) {
  await mkdir(path.join(runtimeRoot, 'worker'), { recursive: true })
  await mkdir(path.join(runtimeRoot, 'scripts'), { recursive: true })
  await mkdir(path.join(runtimeRoot, 'lib/documents'), { recursive: true })
  await writeFile(path.join(runtimeRoot, 'worker/index.mjs'), 'console.log("fake-worker")\n')
  await writeFile(path.join(runtimeRoot, 'scripts/migrate.mjs'), 'console.log("fake-migrate")\n')
  await writeFile(path.join(runtimeRoot, 'scripts/create-user.mjs'), 'console.log("fake-create-user")\n')
  await writeFile(path.join(runtimeRoot, 'lib/documents/pdf-parser-worker.mjs'), 'console.log("fake-pdf")\n')
  await writeFile(path.join(runtimeRoot, 'lib/documents/docx-parser-worker.mjs'), 'console.log("fake-docx")\n')
  if (includeBackupCli) {
    await writeFile(path.join(runtimeRoot, 'scripts/native-backup.mjs'), 'console.log("fake-backup")\n')
  }
  return runtimeRoot
}
