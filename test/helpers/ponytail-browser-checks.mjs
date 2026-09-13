import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Ponytail browser checks for M06/M09/M11/M12/M18/M23 visual acceptance.
// Runs inside native-browser-smoke's isolated session when --ponytail is passed.
// Selectors are semantic (aria/role/text) on purpose: class names differ between the
// tw-animate-css baseline and the local-CSS replacement, so animation evidence records
// duration/easing/fill/computed frames via the Web Animations API and never the name.

const ADMIN = { username: 'browser-admin', password: 'browser-test-password' }
const DESKTOP = { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }

const dateLike = (line) => /[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(line) || /[0-9]{1,2}:[0-9]{2}/.test(line) || /刚刚|秒前|分钟前|小时前|天前|周前/.test(line)
const scrub = (value) => String(value ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !dateLike(line)).join(' | ')

// Collects every svg shape with structural attributes only; gradient/url ids are normalized
// to url(#G) so dynamic ids never enter the before/after comparison.
const SVG_SHAPES = '(() => { const norm = (v) => { const s = String(v ?? ""); return s.indexOf("url(#") === 0 ? "url(#G)" : s; };' +
  'return JSON.stringify([...document.querySelectorAll("svg")].map((svg) => ({' +
  'vb: svg.getAttribute("viewBox"), label: svg.getAttribute("aria-label") || undefined,' +
  'shapes: [...svg.querySelectorAll("path,circle,line,polyline,polygon,rect")].map((el) => {' +
  'const out = { t: el.tagName.toLowerCase() };' +
  'for (const name of ["d","points","x","y","x1","y1","x2","y2","cx","cy","r","rx","width","height","stroke-width","stroke-dasharray","fill","stroke","transform"]) {' +
  'const v = el.getAttribute(name); if (v != null) out[name] = norm(v); } return out; }) }))); })()'

const activeElementLabel = (ctx) => ctx.evaluate('(function(){ const a = document.activeElement; if (!a) return null;' +
  'const label = a.getAttribute && (a.getAttribute("aria-label") || a.getAttribute("title"));' +
  'return label || a.tagName.toLowerCase() + (a.id ? "#" + a.id : ""); })()')

function styleSnapshot(finder, extraSelectors) {
  return '(function(){ const el = (' + finder + '); if (!el) return JSON.stringify([]);' +
    'const pick = (node) => { const cs = getComputedStyle(node); return { tag: node.tagName.toLowerCase(),' +
    'aria: node.getAttribute("aria-label") || undefined, animationDuration: cs.animationDuration,' +
    'animationTimingFunction: cs.animationTimingFunction, animationFillMode: cs.animationFillMode,' +
    'animationIterationCount: cs.animationIterationCount, transitionDuration: cs.transitionDuration,' +
    'transitionTimingFunction: cs.transitionTimingFunction, transformOrigin: cs.transformOrigin }; };' +
    'const out = [pick(el)];' +
    'for (const sel of ' + JSON.stringify(extraSelectors) + ') for (const node of el.querySelectorAll(sel)) out.push(pick(node));' +
    'return JSON.stringify(out); })()'
}

async function captureAnimation(ctx, finder, shotPrefix, times) {
  const setup = JSON.parse(await ctx.evaluate('(function(){ const el = (' + finder + '); if (!el) return JSON.stringify({ missing: true });' +
    'const anims = el.getAnimations(); if (!anims.length) return JSON.stringify({ noAnimation: true });' +
    'const a = anims[0]; a.pause(); window.__ponytailAnim = a; const t = a.effect.getTiming();' +
    'const kf = a.effect.getKeyframes().map((k) => ({ offset: k.offset, easing: k.easing }));' +
    'return JSON.stringify({ count: anims.length, duration: String(t.duration), easing: String(t.easing),' +
    'fill: String(t.fill), delay: String(t.delay), iterations: String(t.iterations), direction: String(t.direction), keyframes: kf }); })()'))
  if (setup.missing || setup.noAnimation) return setup
  const frames = []
  for (const at of times) {
    await ctx.evaluate('(function(){ window.__ponytailAnim.currentTime = ' + at + '; return true; })()')
    const frame = JSON.parse(await ctx.evaluate('(function(){ const el = (' + finder + '); const cs = getComputedStyle(el);' +
      'const raw = cs.transform; const m = new DOMMatrix(raw === "none" ? "matrix(1, 0, 0, 1, 0, 0)" : raw);' +
      'const r = el.getBoundingClientRect();' +
      'return JSON.stringify({ t: ' + at + ', opacity: cs.opacity, transform: raw,' +
      'matrix16: Array.from(m.toFloat32Array()), translate: cs.translate,' +
      'rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100) }); })()'))
    frames.push(frame)
    const image = await ctx.page('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(ctx.root, shotPrefix + '-' + String(at).padStart(3, '0') + '.png'), Buffer.from(image.data, 'base64'))
  }
  await ctx.evaluate('(function(){ if (window.__ponytailAnim) window.__ponytailAnim.play(); return true; })()')
  return { ...setup, frames }
}

async function patchFetch(ctx, paths, mode) {
  await ctx.evaluate('(function(){ const originalFetch = window.fetch;' +
    'window.__ponytailSignals = []; window.__ponytailMatch = ' + JSON.stringify(paths) + '; window.__ponytailMode = ' + JSON.stringify(mode) + ';' +
    'window.fetch = function (input, init) { let raw = "", path = "";' +
    'try { raw = typeof input === "string" ? input : (input instanceof URL ? input.href : (input && input.url) || String(input));' +
    'path = new URL(raw, location.href).pathname; } catch (e) {}' +
    'const hit = window.__ponytailMatch.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));' +
    'if (!hit) return originalFetch.apply(this, arguments);' +
    'if (init && init.signal) window.__ponytailSignals.push(init.signal);' +
    'const current = window.__ponytailMode;' +
    'if (current === "reject-once") { window.__ponytailMode = "pass"; return Promise.reject(new TypeError("Failed to fetch")); }' +
    'if (current && current.delayMs) { const o = this, a = arguments;' +
    'return new Promise((r) => setTimeout(r, current.delayMs)).then(() => originalFetch.apply(o, a)); }' +
    'return originalFetch.apply(this, arguments); }; })()')
}

const restoreFetch = (ctx) => ctx.evaluate('(function(){ if (window.__ponytailOrigFetch) { window.fetch = window.__ponytailOrigFetch; delete window.__ponytailOrigFetch; } return true; })()')
const acceptConfirm = (ctx) => ctx.evaluate('(function(){ window.__ponytailOrigConfirm = window.confirm; window.confirm = () => true; return true; })()')
const restoreConfirm = (ctx) => ctx.evaluate('(function(){ if (window.__ponytailOrigConfirm) { window.confirm = window.__ponytailOrigConfirm; delete window.__ponytailOrigConfirm; } return true; })()')

async function pressEscape(ctx) {
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await ctx.page('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
  await ctx.page('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

const clickTitle = (ctx, selector) => ctx.evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + ');' +
  'if (!el) throw Error("missing " + ' + JSON.stringify(selector) + '); el.click(); return true; })()')

const clickNav = async (ctx, label) => {
  await ctx.evaluate('(() => { const b = [...document.querySelectorAll("nav[aria-label=主要设置导航] button")]' +
    '.find((el) => el.textContent.trim().startsWith(' + JSON.stringify(label) + '));' +
    'if (!b) throw Error("missing nav item " + ' + JSON.stringify(label) + '); b.click(); return true; })()')
}

export async function runPonytailBrowserChecks(context) {
  const { api, page, evaluate, click, navigate, text, waitFor, screenshot, base, projectId, root } = context
  const metrics = { screenshotNames: [], notes: [] }
  const shot = async (name) => {
    await evaluate('window.__ponytailSpinners = document.getAnimations().filter(a => a.playState === "running" && a.effect.getTiming().iterations === Infinity); window.__ponytailSpinners.forEach(a => { a.pause(); a.currentTime = 0; }); true')
    try { await screenshot(name); metrics.screenshotNames.push(name) }
    finally { await evaluate('window.__ponytailSpinners.forEach(a => a.play()); delete window.__ponytailSpinners; true') }
  }
  const overflow = () => evaluate('document.documentElement.scrollWidth > innerWidth + 1')
  const setViewport = (view) => page('Emulation.setDeviceMetricsOverride', view)
  const shapes = async () => JSON.parse(await evaluate(SVG_SHAPES))

  // The --p5 flow ends on a read-only collaborator session; restore the admin one first.
  const me = await api('/api/auth/me')
  if ((me.body.user ?? {}).role !== 'admin') {
    await api('/api/auth/logout', {})
    const login = await api('/api/auth/login', ADMIN)
    assert.equal(login.status, 200, 'ponytail checks need the admin session back')
  }
  await setViewport(DESKTOP)

  await navigate(base + '/?view=overview')
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=分析质量全景]"))'), 'ponytail overview panel')
  await shot('19-ponytail-overview-wide')
  metrics.overviewWide = { shapes: await shapes(), text: scrub(await text()), overflow: await overflow() }

  await navigate(base + '/?view=reports')
  await waitFor(() => evaluate('Boolean(document.querySelector("input[placeholder^=搜索报告名称]"))'), 'ponytail report library')
  await shot('20-ponytail-library-wide')
  metrics.libraryWide = { shapes: await shapes(), text: scrub(await text()), overflow: await overflow() }

  await setViewport(MOBILE)
  await waitFor(() => evaluate('innerWidth === 390'), 'ponytail mobile viewport')
  await navigate(base + '/?view=overview')
  await waitFor(() => evaluate('Boolean(document.querySelector("[aria-label=分析质量全景]"))'), 'ponytail mobile overview')
  await shot('21-ponytail-overview-narrow')
  metrics.overviewNarrow = { text: scrub(await text()), overflow: await overflow() }

  await navigate(base + '/?view=reports')
  await waitFor(() => evaluate('Boolean(document.querySelector("input[placeholder^=搜索报告名称]"))'), 'ponytail mobile library')
  await shot('22-ponytail-library-narrow')
  metrics.libraryNarrow = { text: scrub(await text()), overflow: await overflow() }

  await navigate(base + '/?view=dashboard&project=' + projectId)
  await waitFor(() => evaluate('Boolean(document.querySelector("header h1"))'), 'ponytail mobile dashboard')
  await shot('23-ponytail-dashboard-narrow')
  metrics.dashboardNarrow = { overflow: await overflow(), moduleNavHeights: await evaluate(
    '[...document.querySelectorAll("aside[aria-label=课题模块外挂导航] nav")].filter((el) => el.getBoundingClientRect().width > 0)' +
    '.map((el) => Math.round(el.getBoundingClientRect().height))') }

  await setViewport(DESKTOP)
  await navigate(base + '/?view=overview')
  await waitFor(() => evaluate('Boolean(document.querySelector("button[title=通知]"))'), 'ponytail notification bell')

  // Notification center: the app loads notifications at boot, so reopening the panel never
  // shows the loading state (hasLoaded persists); capture the loaded panel deterministically.
  await clickTitle(context, 'button[title=通知]')
  await waitFor(() => evaluate('Boolean(document.querySelector("#workspace-notification-panel"))'), 'notification panel open')
  await waitFor(() => evaluate('document.body.innerText.includes("团队操作记录")'), 'notification panel loaded')
  await shot('24-ponytail-notifications-loaded')
  await pressEscape(context)
  await waitFor(() => evaluate('!document.querySelector("#workspace-notification-panel")'), 'notification panel closed by Escape')
  const bellFocus = await activeElementLabel(context)
  assert.equal(bellFocus, '通知', 'Escape from the notification panel refocuses the bell')
  const emptySeen = (await text()).includes('暂无通知')

  // Notification failure + in-product retry recovery (real page, no CDP fetch session).
  await patchFetch(context, ['/api/notifications'], 'reject-once')
  await clickTitle(context, 'button[title=通知]')
  await waitFor(() => evaluate('document.body.innerText.includes("Failed to fetch")'), 'notification error state')
  await shot('25-ponytail-notifications-error')
  await restoreFetch(context)
  await evaluate('(() => { const b = [...document.querySelectorAll("#workspace-notification-panel button")]' +
    '.find((el) => el.textContent.trim() === "重试"); if (!b) throw Error("missing retry"); b.click(); return true; })()')
  await waitFor(() => evaluate('!document.body.innerText.includes("Failed to fetch")'), 'notification retry recovery')
  await clickTitle(context, 'button[title=通知]')
  metrics.notifications = { loadingStateOnReopen: false, emptySeen, errorCopy: 'Failed to fetch (raw rejection message surfaced by setError)', retryRecovered: true, escapeFocus: bellFocus }

  // Knowledge base: component-local first-mount loading, then failure + in-place retry.
  const switchModule = async (label) => {
    await evaluate('(() => { const b = [...document.querySelectorAll("button")]'.concat(
      '.find((el) => el.textContent.trim().startsWith(' + JSON.stringify(label) + '));',
      'if (!b) throw Error("missing module nav " + ' + JSON.stringify(label) + '); b.click(); return true; })()'))
  }
  await navigate(base + '/?view=knowledge')
  await waitFor(() => evaluate('document.body.innerText.includes("知识库")'), 'knowledge view reached')
  await patchFetch(context, ['/api/knowledge'], { delayMs: 5000 })
  await switchModule('报告库')
  await switchModule('知识库')
  await waitFor(() => evaluate('document.body.innerText.includes("正在加载…")'), 'knowledge loading state')
  await shot('26-ponytail-knowledge-loading')
  await switchModule('报告库')
  await waitFor(() => evaluate('window.__ponytailSignals.length > 0 && window.__ponytailSignals.every(signal => signal.aborted)'), 'pending request aborted by React unmount')
  await restoreFetch(context)
  await switchModule('知识库')
  await waitFor(() => evaluate('document.body.innerText.includes("份资料")'), 'knowledge loaded')
  await patchFetch(context, ['/api/knowledge'], 'reject-once')
  await switchModule('报告库')
  await switchModule('知识库')
  await waitFor(() => evaluate('document.body.innerText.includes("知识库读取失败")'), 'knowledge error state')
  await shot('26-ponytail-knowledge-error')
  await restoreFetch(context)
  await evaluate('(() => { const b = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "重试");' +
    'if (!b) throw Error("missing knowledge retry"); b.click(); return true; })()')
  await waitFor(() => evaluate('!document.body.innerText.includes("知识库读取失败")'), 'knowledge retry recovery')
  metrics.knowledge = { loadingSeen: true, unmountAborted: true, errorCopy: '知识库读取失败，请重试；已加载的内容会继续保留。', retryRecovered: true }

  // M23 user menu animation: pause/seek the finished CSS animation via WAAPI.
  await evaluate('document.querySelector("button[aria-label=账户菜单]").click()')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=menu]"))'), 'user menu open')
  const menuFinder = 'document.querySelector("[role=menu]")'
  metrics.menuAnimation = await captureAnimation(context, menuFinder, '27-ponytail-menu-frame', [0, 50, 100])
  assert.ok(!metrics.menuAnimation.missing && !metrics.menuAnimation.noAnimation && (metrics.menuAnimation.frames || []).length === 3,
    'user menu must expose a seekable CSS animation with all frames captured')
  for (const at of [0, 50, 100]) metrics.screenshotNames.push('27-ponytail-menu-frame-' + String(at).padStart(3, '0'))
  metrics.menuStyles = JSON.parse(await evaluate(styleSnapshot(menuFinder, ['[role=menuitem]'])))
  metrics.triggerStyles = JSON.parse(await evaluate(styleSnapshot('document.querySelector("button[aria-label=账户菜单]")', ['svg'])))
  await pressEscape(context)
  await waitFor(() => evaluate('!document.querySelector("[role=menu]")'), 'user menu closed by Escape')
  metrics.menuEscapeClosed = true
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('document.querySelector("button[aria-label=账户菜单]").click()')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=menu]"))'), 'reduced-motion menu open')
  metrics.menuReducedMotion = await captureAnimation(context, menuFinder, '28-ponytail-menu-reduced', [0, 50, 100])
  assert.ok(!metrics.menuReducedMotion.missing)
  for (const frame of metrics.menuReducedMotion.frames ?? []) metrics.screenshotNames.push('28-ponytail-menu-reduced-' + String(frame.t).padStart(3, '0'))
  await pressEscape(context)
  await page('Emulation.setEmulatedMedia', { features: [] })

  // Settings dialog: prompts loading, users error + recovery, channels, M23 toast, Escape/focus.
  await evaluate('(() => { const b = document.querySelector("[aria-label=主要设置]"); b.focus(); return true; })()')
  const focusBefore = await activeElementLabel(context)
  await evaluate('document.querySelector("[aria-label=主要设置]").click()')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=dialog] nav[aria-label=主要设置导航]"))'), 'admin settings dialog open')
  metrics.settings = { focusBeforeDialog: focusBefore, initialFocusInsideDialog: await evaluate(
    '(() => { const d = document.querySelector("[role=dialog]"); return d.contains(document.activeElement); })()'),
    initialFocusLabel: await activeElementLabel(context) }

  await patchFetch(context, ['/api/admin/prompt-settings'], { delayMs: 1500 })
  await clickNav(context, '提示词设置')
  await waitFor(() => evaluate('document.body.innerText.includes("正在读取提示词配置…")'), 'prompts loading state')
  await shot('29-ponytail-prompts-loading')
  await restoreFetch(context)
  await waitFor(() => evaluate('document.body.innerText.includes("保存提示词")' +
    ' && !document.body.innerText.includes("正在读取提示词配置…")' +
    ' && !document.body.innerText.includes("Failed to fetch")' +
    ' && !document.body.innerText.includes("提示词读取失败。")'), 'prompts loaded without error')
  await shot('30-ponytail-prompts-loaded')

  await patchFetch(context, ['/api/admin/users'], 'reject-once')
  await clickNav(context, '用户管理')
  await waitFor(() => evaluate('document.body.innerText.includes("Failed to fetch")'), 'users error state')
  await shot('31-ponytail-users-error')
  await restoreFetch(context)
  await clickNav(context, '渠道模型')
  await waitFor(() => evaluate('document.body.innerText.includes("添加渠道") && !document.body.innerText.includes("设置读取失败。")'), 'channels page loaded')
  await shot('32-ponytail-channels-loaded')
  await clickNav(context, '用户管理')
  const usersRowWait = '[...document.querySelectorAll("button")].filter((el) => (el.getAttribute("aria-label") || "").indexOf("编辑用户：") === 0).length > 0'
  await waitFor(() => evaluate(usersRowWait), 'users rows recovered')
  const userRows = await evaluate(usersRowWait.replace('> 0', ''))
  assert.ok(userRows >= 1, 'recovered users list keeps its rows')
  await shot('33-ponytail-users-recovered')
  metrics.users = { errorCopy: 'Failed to fetch (raw rejection message surfaced by setError)', recoveredRows: userRows }

  // M23 notification toast: prompt restore-default is a no-op write that fires the toast.
  await clickNav(context, '提示词设置')
  await waitFor(() => evaluate('document.body.innerText.includes("恢复默认")'), 'prompts ready for toast')
  await acceptConfirm(context)
  await evaluate('(() => { const b = [...document.querySelectorAll("[role=dialog] button")]' +
    '.find((el) => el.textContent.trim() === "恢复默认"); if (!b) throw Error("missing restore default"); b.click(); return true; })()')
  const toastFinder = '[...document.querySelectorAll("[role=dialog] [role=status]")].find((el) => el.textContent.indexOf("已恢复默认。") !== -1)'
  await waitFor(() => evaluate('Boolean(' + toastFinder + ')'), 'toast visible')
  const toastMessage = await evaluate('(' + toastFinder + ').textContent')
  metrics.toastAnimation = await captureAnimation(context, toastFinder, '34-ponytail-toast-frame', [0, 75, 150])
  assert.ok(!metrics.toastAnimation.missing && !metrics.toastAnimation.noAnimation && (metrics.toastAnimation.frames || []).length === 3,
    'toast must expose a seekable CSS animation with all frames captured')
  for (const at of [0, 75, 150]) metrics.screenshotNames.push('34-ponytail-toast-frame-' + String(at).padStart(3, '0'))
  metrics.toastAnimation.message = toastMessage
  metrics.toastStyles = JSON.parse(await evaluate(styleSnapshot(toastFinder, [])))
  metrics.toastStillVisible = await evaluate('Boolean(' + toastFinder + ')')
  await restoreConfirm(context)
  assert.equal(metrics.toastStillVisible, true, 'all toast frames must be captured before auto-dismiss')
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  metrics.toastReducedMotion = await captureAnimation(context, toastFinder, '34-ponytail-toast-reduced', [0, 75, 150])
  assert.ok(!metrics.toastReducedMotion.missing)
  for (const frame of metrics.toastReducedMotion.frames ?? []) metrics.screenshotNames.push('34-ponytail-toast-reduced-' + String(frame.t).padStart(3, '0'))
  await page('Emulation.setEmulatedMedia', { features: [] })

  await pressEscape(context)
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), 'settings dialog closed by Escape')
  metrics.settings.dialogEscapeClosed = true
  metrics.settings.focusRestoredTo = await activeElementLabel(context)
  assert.equal(metrics.settings.focusRestoredTo, focusBefore, 'dialog focus restore')

  await evaluate('document.querySelector("[aria-label=主要设置]").click()')
  await waitFor(() => evaluate('Boolean(document.querySelector("[role=dialog] nav[aria-label=主要设置导航]"))'), 'settings dialog reopened')
  await clickNav(context, '用户管理')
  const reenterRowWait = '[...document.querySelectorAll("button")].filter((el) => (el.getAttribute("aria-label") || "").indexOf("编辑用户：") === 0).length > 0'
  await waitFor(() => evaluate(reenterRowWait), 'users rows after reenter')
  metrics.settings.reenterUserRows = await evaluate(reenterRowWait.replace('> 0', ''))
  await shot('35-ponytail-settings-reenter')
  await pressEscape(context)
  await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), 'settings dialog closed again')

  // B7 static fragments (M06/M11/M20 before/after HTML) rendered in the real browser with
  // the app's compiled CSS, so font-ready screenshots complement the markup comparison.
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
  const fixtureRoot = process.env.PONYTAIL_SSR_FIXTURES
  if (fixtureRoot) {
    const cssFiles = await readdir(join(projectRoot, process.env.YANXING_NEXT_DIST_DIR || '.next', 'static', 'css'))
    assert.ok(cssFiles.some((name) => name.endsWith('.css')), 'compiled CSS is required for SVG fixtures')
    await page('DOM.enable')
    await page('CSS.enable')
    const cssName = cssFiles.find((name) => name.endsWith('.css'))
    const shellDir = join(root, 'ponytail-ssr-shells')
    await mkdir(shellDir, { recursive: true })
    const pairs = ['heatmap-empty', 'heatmap-one', 'heatmap-one-expanded', 'heatmap-long',
      'heatmap-long-expanded', 'heatmap-missing-cells', 'repo-rising']
    metrics.ssrStatic = { css: cssName, results: {} }
    for (const dir of ['original', 'after']) {
      for (const name of pairs) {
        const fragment = await readFile(join(fixtureRoot, dir, name + '.html'), 'utf8')
        const shellPath = join(shellDir, dir + '-' + name + '.html')
        const cssLinks = cssFiles.filter((file) => file.endsWith('.css'))
          .map((file) => '<link rel="stylesheet" href="file://' + join(projectRoot, process.env.YANXING_NEXT_DIST_DIR || '.next', 'static', 'css', file) + '">').join('')
        await writeFile(shellPath, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' + cssLinks +
          '</head><body class="font-sans antialiased">' + fragment + '</body></html>')
        await navigate('file://' + shellPath)
        await waitFor(() => evaluate('document.readyState === "complete" && document.body.children.length > 0'), 'ssr shell ' + dir + '/' + name)
        await evaluate('document.fonts.ready.then(() => true)')
        const document = await page('DOM.getDocument')
        const node = await page('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'svg text' })
        const fonts = node.nodeId ? (await page('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })).fonts : []
        await shot('36-ssr-' + dir + '-' + name)
        metrics.ssrStatic.results[dir + '/' + name] = {
          fonts,
          fontFamily: await evaluate('getComputedStyle(document.body).fontFamily'),
          fontSmoothing: await evaluate('getComputedStyle(document.body).webkitFontSmoothing'),
          svgCount: await evaluate('document.querySelectorAll("svg").length'),
          shapeCount: JSON.parse(await evaluate(SVG_SHAPES)).reduce((sum, svg) => sum + svg.shapes.length, 0),
          text: scrub(await text()),
        }
      }
    }
  } else {
    metrics.notes.push('optional SVG fixtures not requested; set PONYTAIL_SSR_FIXTURES to the original/after fragment directory')
  }

  metrics.checks = ['overview-wide', 'library-wide', 'overview-narrow', 'library-narrow', 'dashboard-narrow',
    'notifications-loaded', 'notifications-error-retry', 'notifications-escape-focus',
    'knowledge-loading', 'knowledge-unmount-cancellation', 'knowledge-error-retry',
    'menu-animation', 'menu-escape', 'settings-prompts-loading', 'settings-users-error-recovery',
    'settings-channels-loaded', 'toast-animation', 'reduced-motion', 'settings-escape-focus-restore', 'settings-reenter']
  if (metrics.ssrStatic) metrics.checks.push('ssr-static-geometry')
  metrics.finishedAt = new Date().toISOString()
  await writeFile(join(root, 'ponytail-metrics.json'), JSON.stringify(metrics, null, 2))
  return { checks: metrics.checks, screenshots: metrics.screenshotNames, metricsFile: 'ponytail-metrics.json' }
}