const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const UUID = '00000000-0000-4000-8000-000000000001'
const TOKEN = 't'.repeat(32)
const SECRET = 's'.repeat(64)

function setup({ failKeys = [], absentKeys = [], fetcher } = {}) {
  const store = {
    nodes: JSON.stringify({ n: { name: 'Fictional', type: 'vless', s: 'example.com', p: 443, u: UUID, security: 'tls', net: 'ws', path: '/test', encryption: 'none', flow: '' } }),
    profiles: JSON.stringify([{ id: 'main', name: 'Main', token: TOKEN, enabled: true, own: 'all', ups: [], regions: 'all', pols: 'all', policies: 'inherit' }]),
    policies: JSON.stringify([{ id: 'all', name: 'All', target: 'all', enabled: true, presets: [], domains: [], keywords: [], processes: [] }]),
    upstreams: '[]',
    'auth:secret': JSON.stringify(SECRET),
    'auth:password': JSON.stringify('existing-fictional-hash'),
  }
  for (const key of absentKeys) delete store[key]
  const writes = []
  const reads = []
  const context = vm.createContext({
    addEventListener() {}, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal,
    structuredClone, setTimeout, clearTimeout, console,
    CONF: {
      get: async (key, type) => {
        reads.push(key)
        if (failKeys.includes(key)) throw new Error('Synthetic storage failure')
        return store[key] === undefined ? null : type === 'json' ? JSON.parse(store[key]) : store[key]
      },
      put: async (key, value) => { writes.push(key); store[key] = value },
      delete: async key => { writes.push(key); delete store[key] },
    },
    fetch: fetcher || (async () => { throw new Error('No real network is allowed in security regression tests') }),
  })
  vm.runInContext(source + '\n;globalThis.T={handle,makeCookie,hashPassword,loadProfiles}', context)
  return { T: context.T, store, reads, writes }
}

function request(T, pathname, { method = 'GET', body, cookie, origin = 'https://panel.example', event } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = 'sess=' + cookie
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers.Origin = origin }
  const req = new Request(origin + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return T.handle(req, event === undefined ? { waitUntil() {} } : event)
}

for (const [pathname, method] of [['/', 'GET'], ['/', 'HEAD'], ['/?theme=dark', 'GET']]) {
  test('homepage without a token navigates to admin without reading KV: ' + method + ' ' + pathname, async () => {
    const { T, reads, writes } = setup()
    const response = await request(T, pathname, { method })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('Location'), '/admin')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000')
    assert.equal(await response.text(), '')
    assert.equal(reads.length, 0)
    assert.equal(writes.length, 0)
  })
}

for (const pathname of ['/?token=', '/?token=short', '/sub']) {
  test('subscription validation is not replaced by homepage navigation: ' + pathname, async () => {
    const { T, writes } = setup()
    const response = await request(T, pathname)
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('Location'), null)
    assert.equal(writes.length, 0)
  })
}

test('root token subscription produces exactly the same content as the sub endpoint', async () => {
  const { T, store, writes } = setup()
  const before = JSON.stringify(store)
  const query = '?token=' + TOKEN + '&upstream=0&fmt=share'
  const root = await request(T, '/' + query, { event: null })
  const sub = await request(T, '/sub' + query, { event: null })
  assert.equal(root.status, 200)
  assert.equal(root.headers.get('Location'), null)
  const text = await root.text()
  assert.equal(text, await sub.text())
  assert.ok(Buffer.from(text, 'base64').toString('utf8').includes(UUID))
  assert.equal(JSON.stringify(store), before)
  assert.equal(writes.length, 0)
})

test('homepage navigation does not redirect POST requests or bypass admin authentication', async () => {
  const { T, writes } = setup()
  const post = await request(T, '/', { method: 'POST', body: {} })
  assert.equal(post.status, 403)
  assert.equal(post.headers.get('Location'), null)
  const admin = await request(T, '/api/own')
  assert.equal(admin.status, 401)
  assert.equal(writes.length, 0)
})

for (const pathname of ['/admin', '/sub?token=' + TOKEN, '/api/own']) {
  test('HTTP navigation redirects before reading KV: ' + pathname.split('?')[0], async () => {
    const { T, reads, writes } = setup()
    const response = await request(T, pathname, { origin: 'http://panel.example' })
    assert.equal(response.status, 308)
    assert.equal(response.headers.get('Location'), 'https://panel.example' + pathname)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(await response.text(), '')
    assert.equal(reads.length, 0)
    assert.equal(writes.length, 0)
  })
}

test('HTTP sensitive POST is rejected rather than replaying its body through a redirect', async () => {
  const { T, reads, writes } = setup()
  const response = await request(T, '/admin/login', { origin: 'http://panel.example', method: 'POST', body: { password: 'fictional-value' } })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('Location'), null)
  assert.equal(reads.length, 0)
  assert.equal(writes.length, 0)
})

test('localhost HTTP development remains available without HSTS', async () => {
  const { T } = setup()
  const response = await request(T, '/admin', { origin: 'http://localhost:8787' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Strict-Transport-Security'), null)
})

for (const [pathname, status] of [['/admin', 200], ['/api/own', 401], ['/sub', 403]]) {
  test('HTTPS responses retain HSTS, including rejected requests: ' + pathname, async () => {
    const { T } = setup()
    const response = await request(T, pathname)
    assert.equal(response.status, status)
    assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000')
  })
}

test('password read failure returns 503 without changing any stored state', async () => {
  const { T, store, writes } = setup({ failKeys: ['auth:password'] })
  const before = JSON.stringify(store)
  const response = await request(T, '/admin/login', { method: 'POST', body: { password: 'fictional-value' } })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Set-Cookie'), null)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(JSON.stringify(store), before)
  assert.equal(writes.length, 0)
})

test('admin page cannot present initialization UI when its password read fails', async () => {
  const { T, writes } = setup({ failKeys: ['auth:password'] })
  const response = await request(T, '/admin')
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8')
  assert.equal(writes.length, 0)
})

test('temporary password storage failures release the login reservation without locking out recovery', async () => {
  const failKeys = ['auth:password']
  const { T, store } = setup({ failKeys })
  store['auth:password'] = JSON.stringify(await T.hashPassword('fictional-normal-login'))
  for (let i = 0; i < 6; i++) {
    const response = await request(T, '/admin/login', { method: 'POST', body: { password: 'fictional-normal-login' } })
    assert.equal(response.status, 503)
  }
  failKeys.length = 0
  const response = await request(T, '/admin/login', { method: 'POST', body: { password: 'fictional-normal-login' } })
  assert.equal(response.status, 200)
})

for (const value of ['', {}, 17]) {
  test('invalid stored password state cannot be treated as an uninitialized site: ' + JSON.stringify(value), async () => {
    const { T, store, writes } = setup()
    store['auth:password'] = JSON.stringify(value)
    const response = await request(T, '/admin/login', { method: 'POST', body: { password: 'fictional-value' } })
    assert.equal(response.status, 503)
    assert.equal(writes.length, 0)
  })
}

test('profile read failure returns 503 without default authorization or node data', async () => {
  const { T, writes } = setup({ failKeys: ['profiles'] })
  const response = await request(T, '/sub?token=' + TOKEN)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000')
  const text = await response.text()
  assert.ok(!text.includes(UUID))
  assert.ok(!text.includes(TOKEN))
  assert.equal(writes.length, 0)
})

test('session-key read failure returns 503 and cannot generate or overwrite a key', async () => {
  const { T, store, writes } = setup({ failKeys: ['auth:secret'] })
  const cookie = await T.makeCookie(SECRET)
  const before = store['auth:secret']
  const response = await request(T, '/api/own', { cookie })
  assert.equal(response.status, 503)
  assert.equal(store['auth:secret'], before)
  assert.equal(writes.length, 0)
})

test('missing session key rejects an old session without persisting a new key', async () => {
  const { T, store, writes } = setup({ absentKeys: ['auth:secret'] })
  const response = await request(T, '/api/own', { cookie: await T.makeCookie(SECRET) })
  assert.equal(response.status, 401)
  assert.equal(store['auth:secret'], undefined)
  assert.equal(writes.length, 0)
})

test('malformed profile state cannot restore a default subscription', async () => {
  const { T, store, writes } = setup()
  store.profiles = '{}'
  const response = await request(T, '/sub?token=' + TOKEN)
  assert.equal(response.status, 503)
  assert.equal(writes.length, 0)
})

test('healthy login and subscription preserve all existing credentials', async () => {
  const { T, store, writes } = setup()
  store['auth:password'] = JSON.stringify(await T.hashPassword('fictional-normal-login'))
  const before = JSON.stringify(store)
  const login = await request(T, '/admin/login', { method: 'POST', body: { password: 'fictional-normal-login' } })
  assert.equal(login.status, 200)
  assert.ok(login.headers.get('Set-Cookie').includes('Secure'))
  const response = await request(T, '/sub?token=' + TOKEN + '&upstream=0&fmt=share', { event: null })
  assert.equal(response.status, 200)
  const decoded = Buffer.from(await response.text(), 'base64').toString('utf8')
  assert.ok(decoded.includes(UUID))
  assert.equal(JSON.stringify(store), before)
  assert.equal(writes.length, 0)
})

test('confirmed absent password can still be initialized on HTTPS', async () => {
  const { T, writes } = setup({ absentKeys: ['auth:password'] })
  const response = await request(T, '/admin/login', { method: 'POST', body: { password: 'fictional-initial-password' } })
  assert.equal(response.status, 200)
  assert.deepEqual(writes, ['auth:password'])
})

const vmess = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'Fictional', add: 'example.com', port: '443', id: UUID, aid: '0', scy: 'auto', net: 'ws', path: '/test', tls: 'tls' })).toString('base64')
const yamlNode = 'proxies:\n  - name: Fictional\n    type: ss\n    server: example.com\n    port: 443\n    cipher: aes-128-gcm\n    "password": "fictional-sensitive-value"\n'
for (const [label, payload] of [['VMess', vmess], ['YAML', yamlNode]]) {
  test(label + ' probe returns only safe metadata, not raw node lines, notices or arbitrary headers', async () => {
    const { T, store } = setup({ fetcher: async () => new Response('# 剩余流量：1GB fictional-sensitive-value\n' + payload, { headers: { 'Content-Type': 'text/plain', 'Subscription-Userinfo': 'upload=1; download=2; total=100; expire=2000000000; token=fictional-sensitive-value', 'Profile-Web-Page-Url': 'https://example.com/?token=fictional-sensitive-value', 'Content-Disposition': 'fictional-sensitive-value' } }) })
    store.upstreams = JSON.stringify([{ id: 'source', name: 'Fictional source', url: 'https://example.com/sub', enabled: true }])
    const response = await request(T, '/api/probe', { method: 'POST', cookie: await T.makeCookie(SECRET), body: { id: 'source' } })
    assert.equal(response.status, 200)
    const text = await response.text()
    const result = JSON.parse(text)
    assert.equal(result.ok, true)
    assert.equal(result.nodes, 1)
    assert.ok(!text.includes(UUID))
    assert.ok(!text.includes('fictional-sensitive-value'))
    assert.ok(!text.includes(vmess))
    assert.equal(result.sample, undefined)
    assert.equal(result.notes, undefined)
    assert.equal(result.noteCount, 1)
    assert.equal(result.meta.total, 100)
    assert.equal(result.headers['subscription-userinfo'], 'upload=1; download=2; total=100; expire=2000000000')
  })
}

for (const mode of ['http-error', 'network-error']) {
  test('probe ' + mode + ' does not echo remote bodies or exception messages', async () => {
    const { T, store } = setup({ fetcher: async () => {
      if (mode === 'network-error') throw new Error('fictional-sensitive-value')
      return new Response('fictional-sensitive-value', { status: 403 })
    } })
    store.upstreams = JSON.stringify([{ id: 'source', name: 'Fictional source', url: 'https://example.com/sub', enabled: true }])
    const response = await request(T, '/api/probe', { method: 'POST', cookie: await T.makeCookie(SECRET), body: { id: 'source' } })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes('fictional-sensitive-value'))
    assert.equal(JSON.parse(text).tries.length, 5)
  })
}
