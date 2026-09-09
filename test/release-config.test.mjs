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

test('production image copies only assembled runtime without setting runtime CI', async () => {
  const dockerfile = await readProjectFile('Dockerfile')
  assert.ok(dockerfile.includes('RUN pnpm build:docker'))
  assert.ok(dockerfile.includes('COPY --from=build --chown=root:root /app/.docker-runtime ./'))
  const runtimeStage = dockerfile.split(' AS runtime')[1]
  assert.ok(runtimeStage)
  assert.doesNotMatch(runtimeStage, /COPY.*\/app\/node_modules|COPY.*\/app\/\.next/)
  assert.doesNotMatch(runtimeStage, /\bCI\s*=/)
})

test('Docker deployment exposes one supervised app with image-level combined health', async () => {
  const compose = await readProjectFile('compose.yaml')
  const services = compose.split('services:\n')[1].split('\nvolumes:')[0]
  assert.deepEqual([...services.matchAll(/^  ([a-z]+):$/gm)].map((match) => match[1]), ['app'])
  assert.doesNotMatch(compose, /depends_on:|YANXING_(?:WEB|WORKER)_(?:MEMORY|CPUS)|command:/)
  assert.match(compose, /init: true/)
  assert.match(compose, /stop_grace_period: 100s/)
  assert.match(compose, /data:\/app\/storage/)
  assert.ok(compose.includes('mem_limit: ${YANXING_MEMORY:-4g}'))
  assert.ok(compose.includes('cpus: ${YANXING_CPUS:-4}'))
  const dockerfile = await readProjectFile('Dockerfile')
  assert.match(dockerfile, /HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=3/)
  assert.ok(dockerfile.includes('CMD ["node", "/app/scripts/docker-healthcheck.mjs"]'))
  assert.match(dockerfile, /CMD \[\]\s*$/)
  assert.match(dockerfile, /YANXING_WORKER_HEARTBEAT_PATH=\/tmp\/yanxing-worker-heartbeat.json/)
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

test('release publishing waits for the reusable CI workflow', async () => {
  const ci = await readProjectFile('.github/workflows/ci.yml')
  const release = await readProjectFile('.github/workflows/docker-release.yml')
  assert.match(ci, /^  workflow_call:/m)
  assert.equal(ci.split('ref: ${{ github.sha }}').length - 1, 2)
  assert.ok(release.includes('ref: ${{ github.sha }}'))
  assert.match(release, /release:\s+types: \[published\]/)
  assert.match(release, /verify:\s+uses: \.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /publish:\s+needs: verify/)
  assert.match(release, /packages: write/)
  assert.match(release, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  assert.match(release, /platforms: linux\/amd64/)
  assert.match(release, /push: true/)
})

test('release image tags isolate prereleases and publishing actions are pinned', async () => {
  const release = await readProjectFile('.github/workflows/docker-release.yml')
  assert.match(release, /images: ghcr\.io\/anacondakc\/yanxing/)
  assert.match(release, /latest=false/)
  assert.match(release, /type=ref,event=tag/)
  assert.ok(release.includes('type=raw,value=latest,enable=${{ !github.event.release.prerelease }}'))
  assert.match(release, /cancel-in-progress: false/)
  const actionReferences = [...release.matchAll(/uses: ([^\s]+)/g)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('./'))
  assert.ok(actionReferences.length > 0)
  for (const reference of actionReferences) {
    assert.match(reference, /@[a-f0-9]{40}$/, reference)
  }
})
