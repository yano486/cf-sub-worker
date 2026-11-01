const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const SECRET = 's'.repeat(64)
const UUID = '00000000-0000-4000-8000-000000000001'
const feed = `vless://${UUID}@example.com:443?encryption=none&security=tls&type=ws&path=%2Ftest#Fictional`
const clone = value => JSON.parse(JSON.stringify(value))

function setup(upstreams = [], { failWriteKeys = [] } = {}) {
  const store = { upstreams: JSON.stringify(upstreams), 'auth:secret': JSON.stringify(SECRET), 'auth:password': JSON.stringify('fictional-existing-hash') }
  const calls = []
  const context = vm.createContext({
    addEventListener() {}, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal,
    structuredClone, setTimeout, clearTimeout, console,
    CONF: {
      get: async (key, type) => store[key] === undefined ? null : type === 'json' ? JSON.parse(store[key]) : store[key],
      put: async (key, value) => { if (failWriteKeys.includes(key) || (failWriteKeys.includes('snap:*') && key.startsWith('snap:'))) throw new Error('Synthetic snapshot write failure'); store[key] = value },
      delete: async key => { delete store[key] },
    },
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(feed) },
  })
  vm.runInContext(source + '\n;globalThis.T={handle,makeCookie,loadNodes,fetchUpstream,adminHTML,installLocalFetchClient}', context)
  return { T: context.T, store, calls }
}
async function call(T, pathname, body, { anonymous = false, event = null } = {}) {
  const headers = { Origin: 'https://panel.example' }
  if (!anonymous) headers.Cookie = 'sess=' + await T.makeCookie(SECRET)
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return T.handle(new Request('https://panel.example' + pathname, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }), event)
}

test('production-style local snapshot failure reports an error and preserves source/cache instead of returning success', async () => {
  const initial = { id: 'local', name: 'Local', url: 'https://feeds.example/sub', updateMode: 'local', auto: false, enabled: true }
  const { T, store, calls } = setup([initial], { failWriteKeys: ['snap:*'] })
  store['cache:nodes'] = JSON.stringify({ at: 1, nodes: [] })
  const before = clone(store), pending = []
  const response = await call(T, '/api/upstreams', { act: 'edit', id: 'local', updateMode: 'local', text: feed }, { event: { waitUntil: p => pending.push(p.catch(() => {})) } })
  await Promise.all(pending)
  assert.equal(response.status, 503)
  assert.deepEqual(store, before)
  assert.equal(calls.length, 0)
})

test('failed initial local snapshot cannot create an unusable source in the production event path', async () => {
  const { T, store, calls } = setup([], { failWriteKeys: ['snap:*'] })
  const pending = []
  const response = await call(T, '/api/upstreams', { act: 'add', url: 'https://feeds.example/sub', updateMode: 'local', text: feed }, { event: { waitUntil: p => pending.push(p.catch(() => {})) } })
  await Promise.all(pending)
  assert.equal(response.status, 503)
  assert.equal(store.upstreams, '[]')
  assert.equal(calls.length, 0)
})

for (const current of [
  { id: 'local', name: 'Local', url: 'https://feeds.example/new', updateMode: 'local', auto: false },
  { id: 'local', name: 'Local', url: 'https://feeds.example/sub', updateMode: 'auto', auto: true },
]) {
  test('a finished browser download cannot overwrite a concurrently changed source: ' + current.updateMode + ' ' + current.url, async () => {
    const { T, store, calls } = setup([current])
    const before = clone(store)
    const response = await call(T, '/api/upstreams', { act: 'edit', id: 'local', updateMode: 'local', localRefresh: true, expectedUrl: 'https://feeds.example/sub', expectedMode: 'local', text: feed })
    assert.equal(response.status, 409)
    assert.deepEqual(store, before)
    assert.equal(calls.length, 0)
  })
}

test('local refresh requires an unchanged source identity and can update a matching snapshot', async () => {
  const { T, store, calls } = setup([{ id: 'local', name: 'Local', url: 'https://feeds.example/sub', updateMode: 'local', auto: false }])
  const bad = await call(T, '/api/upstreams', { act: 'edit', id: 'local', updateMode: 'local', localRefresh: true, text: feed })
  assert.equal(bad.status, 400)
  const good = await call(T, '/api/upstreams', { act: 'edit', id: 'local', updateMode: 'local', localRefresh: true, expectedUrl: 'https://feeds.example/sub', expectedMode: 'local', text: feed })
  assert.equal(good.status, 200)
  assert.ok(store['snap:local'])
  assert.equal(calls.length, 0)
})

test('local source import uses supplied browser content and retains its own update mode', async () => {
  const { T, store, calls } = setup()
  const response = await call(T, '/api/upstreams', { act: 'add', name: 'Local', url: 'https://feeds.example/sub', updateMode: 'local', text: feed, userinfo: 'upload=1; download=2; total=100; expire=2000000000' })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.up.updateMode, 'local')
  assert.equal(result.up.auto, false)
  assert.equal(result.up.n, 1)
  assert.equal(JSON.parse(store['snap:' + result.up.id]).info.total, 100)
  await T.loadNodes(true, null)
  assert.equal(calls.length, 0)
})

test('local mode cannot silently fetch from CF when browser content or snapshot is absent', async () => {
  const { T, store, calls } = setup([{ id: 'local', name: 'Local', url: 'https://feeds.example/sub', updateMode: 'local', auto: false, enabled: true }])
  const before = store.upstreams
  const response = await call(T, '/api/upstreams', { act: 'add', name: 'New', url: 'https://feeds.example/new', updateMode: 'local' })
  assert.equal(response.status, 400)
  assert.equal(store.upstreams, before)
  const loaded = await T.loadNodes(true, null)
  assert.equal(loaded.nodes.length, 0)
  assert.ok(loaded.errors.length > 0)
  assert.equal(calls.length, 0)
  await assert.rejects(() => T.fetchUpstream({ id: 'local', url: 'https://feeds.example/sub', updateMode: 'local' }))
  assert.equal(calls.length, 0)
})

test('probe of a local source reports local mode without any CF network request', async () => {
  const { T, calls } = setup([{ id: 'local', name: 'Local', url: 'https://feeds.example/sub', updateMode: 'local', auto: false }])
  const response = await call(T, '/api/probe', { id: 'local' })
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.local, true)
  assert.deepEqual(result.tries, [])
  assert.equal(calls.length, 0)
})

test('editing local source metadata does not download; replacing its URL requires a new local snapshot', async () => {
  const initial = { id: 'local', name: 'Before', url: 'https://feeds.example/sub', updateMode: 'local', auto: false, enabled: true }
  const { T, store, calls } = setup([initial])
  const rename = await call(T, '/api/upstreams', { act: 'edit', id: 'local', name: 'After', updateMode: 'local' })
  assert.equal(rename.status, 200)
  const before = store.upstreams
  const bad = await call(T, '/api/upstreams', { act: 'edit', id: 'local', url: 'https://feeds.example/new', updateMode: 'local' })
  assert.equal(bad.status, 400)
  assert.equal(store.upstreams, before)
  const good = await call(T, '/api/upstreams', { act: 'edit', id: 'local', url: 'https://feeds.example/new', updateMode: 'local', text: feed })
  assert.equal(good.status, 200)
  assert.equal(JSON.parse(store.upstreams)[0].url, 'https://feeds.example/new')
  assert.equal(JSON.parse(store.upstreams)[0].updateMode, 'local')
  assert.equal(calls.length, 0)
})

test('existing automatic and manual sources retain their stored shape when a local source is added', async () => {
  const prior = [{ id: 'auto', name: 'Auto', url: 'https://auto.example/sub', enabled: true }, { id: 'manual', name: 'Manual', url: 'https://manual.example/sub', auto: false, enabled: true }]
  const { T, store } = setup(prior)
  assert.equal((await call(T, '/api/upstreams', { act: 'add', url: 'https://feeds.example/sub', updateMode: 'local', text: feed })).status, 200)
  assert.deepEqual(JSON.parse(store.upstreams).slice(0, 2), prior)
})

for (const [mode, expectedAuto] of [['auto', true], ['manual', false]]) {
  test('new source explicit ' + mode + ' mode agrees with the existing auto setting', async () => {
    const { T, calls } = setup()
    const response = await call(T, '/api/upstreams', { act: 'add', name: mode, url: 'https://feeds.example/sub', updateMode: mode })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.up.auto, expectedAuto)
    assert.equal(result.up.updateMode, mode)
    assert.equal(calls.length, 1)
  })
}

test('unrecognized update modes are rejected without a fetch or stored changes', async () => {
  const { T, calls, store } = setup()
  const response = await call(T, '/api/upstreams', { act: 'add', url: 'https://feeds.example/sub', updateMode: 'unknown' })
  assert.equal(response.status, 400)
  assert.equal(store.upstreams, '[]')
  assert.equal(calls.length, 0)
})

test('local browser helper needs authentication and only allows the selected HTTPS origin', async () => {
  const { T, calls } = setup()
  const pathname = '/admin/local-fetch?origin=' + encodeURIComponent('https://feeds.example')
  assert.equal((await call(T, pathname, undefined, { anonymous: true })).status, 401)
  const response = await call(T, pathname)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const csp = response.headers.get('Content-Security-Policy')
  assert.ok(csp.includes("connect-src 'self' https://feeds.example;"))
  assert.ok(!csp.includes("connect-src 'self' https:;"))
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  const main = await call(T, '/admin')
  assert.ok(main.headers.get('Content-Security-Policy').includes("connect-src 'self';"))
  assert.equal(calls.length, 0)
})

for (const origin of ['http://feeds.example', 'https://feeds.example/path', 'https://name:fictional@feeds.example', 'invalid']) {
  test('local helper rejects an invalid or insecure allowed origin: ' + origin, async () => {
    const { T, calls } = setup()
    const response = await call(T, '/admin/local-fetch?origin=' + encodeURIComponent(origin))
    assert.equal(response.status, 400)
    assert.equal(calls.length, 0)
  })
}

test('the local helper performs a browser-only, credential-free request and reports CORS failure clearly', async () => {
  const { T } = setup()
  const response = await call(T, '/admin/local-fetch?origin=' + encodeURIComponent('https://feeds.example'))
  const html = await response.text()
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
  const posted = [], requests = [], listeners = {}
  const opener = { postMessage: (value, origin) => posted.push({ value, origin }) }
  const status = { textContent: '' }
  const win = { opener, addEventListener: (event, fn) => { listeners[event] = fn }, removeEventListener() {} }
  const ctx = vm.createContext({ window: win, location: { origin: 'https://panel.example' }, document: { getElementById: () => status }, URL, TextEncoder, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); throw new TypeError('Synthetic cross-origin denial') }, console })
  vm.runInContext(script, ctx)
  assert.ok(posted.some(x => x.value.kind === 'local-feed-ready'))
  assert.equal(typeof listeners.message, 'function')
  await listeners.message({ source: opener, origin: 'https://panel.example', data: { kind: 'local-feed-start', url: 'https://feeds.example/sub?token=fictional', requestId: 'fictional-request' } })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].options.credentials, 'omit')
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer')
  assert.equal(requests[0].options.mode, 'cors')
  assert.equal(requests[0].options.redirect, 'error')
  const result = posted.find(x => x.value.kind === 'local-feed-result')
  assert.equal(result.origin, 'https://panel.example')
  assert.equal(result.value.ok, false)
  assert.match(result.value.error, /CORS|跨域/)
  assert.ok(!JSON.stringify(result).includes('token=fictional'))
})

test('the browser helper returns a bounded successful download and exposed usage header to its opener', async () => {
  const { T } = setup()
  const html = await (await call(T, '/admin/local-fetch?origin=' + encodeURIComponent('https://feeds.example'))).text()
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
  const posted = [], listeners = {}, status = { textContent: '' }
  const opener = { postMessage: (value, origin) => posted.push({ value, origin }) }
  const ctx = vm.createContext({ window: { opener, addEventListener: (event, fn) => { listeners[event] = fn } }, location: { origin: 'https://panel.example' }, document: { getElementById: () => status }, URL, TextEncoder, TextDecoder, Uint8Array, AbortController, setTimeout, clearTimeout,
    fetch: async () => new Response(feed, { headers: { 'Subscription-Userinfo': 'upload=1; download=2; total=100' } }) })
  vm.runInContext(script, ctx)
  await listeners.message({ source: opener, origin: 'https://panel.example', data: { kind: 'local-feed-start', url: 'https://feeds.example/sub', requestId: 'fictional' } })
  const result = posted.find(x => x.value.kind === 'local-feed-result')
  assert.equal(result.value.ok, true)
  assert.equal(result.value.text, feed)
  assert.equal(result.value.userinfo, 'upload=1; download=2; total=100')
})

test('parent browser opens only an origin-scoped helper URL and closes it after transferring content', async () => {
  const { T } = setup()
  const listeners = {}, messages = [], opened = []
  const popup = { closed: false, close() { this.closed = true }, postMessage: (data, origin) => messages.push({ data, origin }) }
  const win = { addEventListener: (event, fn) => { listeners[event] = fn }, removeEventListener: event => { delete listeners[event] }, open: url => { opened.push(url); return popup } }
  const ctx = vm.createContext({ window: win, location: { origin: 'https://panel.example', hostname: 'panel.example' }, URL, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval })
  vm.runInContext('(' + T.installLocalFetchClient.toString() + ')()', ctx)
  const result = win.pullLocalSubscription('https://feeds.example/sub?token=fictional')
  assert.equal(opened[0], '/admin/local-fetch?origin=https%3A%2F%2Ffeeds.example')
  assert.ok(!opened[0].includes('token'))
  listeners.message({ origin: 'https://panel.example', source: popup, data: { kind: 'local-feed-ready' } })
  assert.equal(messages[0].data.url, 'https://feeds.example/sub?token=fictional')
  assert.equal(messages[0].origin, 'https://panel.example')
  listeners.message({ origin: 'https://panel.example', source: popup, data: { kind: 'local-feed-result', requestId: messages[0].data.requestId, ok: true, text: feed } })
  assert.deepEqual(clone(await result), { text: feed, userinfo: '' })
  assert.equal(popup.closed, true)
  assert.equal(listeners.message, undefined)
})

test('a blocked browser popup gives an actionable error rather than using a server fallback', async () => {
  const { T } = setup()
  const ctx = vm.createContext({ window: { addEventListener() {}, removeEventListener() {}, open: () => null }, location: { origin: 'https://panel.example', hostname: 'panel.example' }, URL, crypto: webcrypto, setTimeout, clearTimeout, setInterval, clearInterval })
  vm.runInContext('(' + T.installLocalFetchClient.toString() + ')()', ctx)
  await assert.rejects(() => ctx.window.pullLocalSubscription('https://feeds.example/sub'), /弹出窗口/)
})

test('the generated admin script initializes adjacent editor and local-network installers independently', () => {
  const { T } = setup()
  const html = T.adminHTML(true, true)
  const start = html.indexOf('(function installOwnEditor()')
  const end = html.indexOf('window.delOwn =', start)
  assert.ok(start > 0 && end > start)
  const ctx = vm.createContext({ window: {} })
  vm.runInContext(html.slice(start, end), ctx)
  assert.equal(typeof ctx.window.editOwn, 'function')
  assert.equal(typeof ctx.window.pullLocalSubscription, 'function')
})
