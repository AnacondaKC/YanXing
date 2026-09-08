import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const readProjectFile = (file) => readFile(new URL(file, root), 'utf8')
const packageJson = JSON.parse(await readProjectFile('package.json'))
const nodeVersion = (await readProjectFile('.nvmrc')).trim()
const pnpmVersion = packageJson.packageManager.replace(/^pnpm@/, '')

test('release baseline supports only the documented Node 24 line', async () => {
  assert.match(nodeVersion, /^24\.\d+\.\d+$/)
  assert.equal(packageJson.engines.node, `>=${nodeVersion} <25`)
  assert.match(packageJson.devDependencies['@types/node'], /^\^24\./)
  const readme = await readProjectFile('README.md')
  assert.ok(readme.includes(nodeVersion))
  assert.ok(readme.includes(pnpmVersion))
})

test('Docker and environment examples use the same Node and pnpm baseline', async () => {
  const image = `node:${nodeVersion}-bookworm-slim`
  const dockerfile = await readProjectFile('Dockerfile')
  assert.ok(dockerfile.includes(`ARG NODE_IMAGE=${image}`))
  assert.ok(dockerfile.includes(`npm install --global pnpm@${pnpmVersion}`))
  for (const file of ['compose.yaml', '.env.example', 'docs/docker-deployment.md']) {
    assert.ok((await readProjectFile(file)).includes(image), file)
  }
})

test('production dependency pruning is non-interactive without setting runtime CI', async () => {
  const dockerfile = await readProjectFile('Dockerfile')
  const productionStage = dockerfile.split('FROM dependencies AS production-dependencies')[1]?.split('FROM ')[0]
  assert.ok(productionStage?.includes('RUN CI=true pnpm prune --prod'))
  const runtimeStage = dockerfile.split(' AS runtime')[1]
  assert.ok(runtimeStage)
  assert.doesNotMatch(runtimeStage, /\bCI\s*=/)
})

test('CI reads the repository Node baseline and packageManager without publishing images', async () => {
  const workflow = await readProjectFile('.github/workflows/ci.yml')
  assert.equal((workflow.match(/node-version-file: \.nvmrc/g) ?? []).length, 2)
  assert.doesNotMatch(workflow, /node-version:/)
  assert.match(workflow, /uses: pnpm\/action-setup@v4/)
  assert.doesNotMatch(workflow, /version: 11(?:\s|$)/)
  assert.ok(workflow.includes('pnpm install --frozen-lockfile'))
  assert.ok(workflow.includes('sh scripts/test-docker.sh'))
  assert.doesNotMatch(workflow, /docker\s+push|push:\s*true|packages:\s*write/)
})
