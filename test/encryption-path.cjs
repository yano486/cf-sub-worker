const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const UUID = '00000000-0000-4000-8000-000000000001'
const ENC = 'mlkem768x25519plus.native.1rtt.' + Buffer.alloc(32, 1).toString('base64url')
const encodeVMess = data => 'vmess://' + Buffer.from(JSON.stringify(data)).toString('base64')
const decodeVMess = link => JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8'))

function setup() {
  const store = {
    policies: JSON.stringify([{ id: 'all', name: 'All', target: 'all', enabled: true, presets: [], domains: [], keywords: [], processes: [] }]),
    profiles: JSON.stringify([{ id: 'main', name: 'Main', token: 'e'.repeat(32), enabled: true, own: 'all', ups: [], regions: 'all', pols: 'all', policies: 'inherit' }]),
  }
  const context = vm.createContext({
    addEventListener() {}, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
    URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal,
    structuredClone, setTimeout, clearTimeout, console,
    CONF: {
      get: async (key, type) => store[key] === undefined ? null : type === 'json' ? JSON.parse(store[key]) : store[key],
      put: async (key, value) => { store[key] = value },
      delete: async key => { delete store[key] },
    },
    fetch: async () => { throw new Error('Encryption tests must not access real nodes') },
  })
  vm.runInContext(source + '\n;globalThis.T={shareToOwn,shareLink,apiRoute,makeCookie,installOwnEditor}', context)
  return context.T
}

async function call(T, pathname, body) {
  const request = new Request('https://enc.example' + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: 'sess=' + await T.makeCookie(), 'Content-Type': 'application/json', Origin: 'https://enc.example' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const response = await T.apiRoute(request, new URL(request.url), { waitUntil() {} })
  return { status: response.status, body: await response.json() }
}

const networks = ['ws', 'httpupgrade', 'h2', 'xhttp']
const paths = ['/route?enc=path-value&encryption=path-only', '/enc%2Froute?literal=%26encryption%3Dpath-only+value']
for (const type of ['vless', 'vmess']) for (const net of networks) for (const inputPath of paths) {
  test(type + '/' + net + ' keeps protocol encryption separate from path ' + inputPath, async () => {
    const T = setup()
    const query = new URLSearchParams({ path: inputPath, type: net, security: 'tls', encryption: type === 'vless' ? ENC : 'aes-128-gcm' })
    const result = await call(T, '/api/parse-share', { link: `${type}://${UUID}@example.com:443?${query}#ENC` })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.ok(result.body.node, JSON.stringify(result.body))
    const node = result.body.node
    assert.equal(node.path, inputPath)
    assert.equal(node[type === 'vless' ? 'encryption' : 'cipher'], type === 'vless' ? ENC : 'aes-128-gcm')
    const save = await call(T, '/api/own', { own: { n: node } })
    assert.equal(save.status, 200, JSON.stringify(save.body))
    const saved = (await call(T, '/api/own')).body.own.n
    const exported = T.shareLink({ name: saved.name, own: true, o: saved })
    if (type === 'vless') {
      const params = new URL(exported).searchParams
      assert.equal(params.get('encryption'), ENC)
      assert.equal(params.get('path'), inputPath)
    } else {
      const json = decodeVMess(exported)
      assert.equal(json.scy, 'aes-128-gcm')
      assert.equal(json.path, inputPath)
    }
  })
}

for (const net of networks) {
  test('VMess JSON/' + net + ' path is literal JSON, not another URI-encoded layer', () => {
    const T = setup()
    const json = { v: '2', ps: 'VMess-ENC', add: 'example.com', port: '443', id: UUID, aid: '0', scy: 'chacha20-poly1305', net, type: 'none', path: '/enc%2Froute?enc=literal%26value+text', tls: 'tls' }
    const result = T.shareToOwn(encodeVMess(json))
    assert.ok(result?.node, result?.err)
    assert.equal(result.node.cipher, 'chacha20-poly1305')
    assert.equal(result.node.path, '/enc%2Froute?enc=literal%26value+text')
    const exported = decodeVMess(T.shareLink({ name: result.node.name, own: true, o: result.node }))
    assert.equal(exported.scy, 'chacha20-poly1305')
    assert.equal(exported.path, '/enc%2Froute?enc=literal%26value+text')
  })
}

test('VLESS TCP encryption remains independent with no transport path', () => {
  const T = setup()
  const result = T.shareToOwn(`vless://${UUID}@example.com:443?encryption=${ENC}&security=none&type=tcp#VLESS-ENC`)
  assert.ok(result?.node, result?.err)
  assert.equal(result.node.encryption, ENC)
  assert.equal(result.node.path, undefined)
  const exported = new URL(T.shareLink({ name: result.node.name, own: true, o: result.node })).searchParams
  assert.equal(exported.get('encryption'), ENC)
  assert.equal(exported.has('path'), false)
})

test('VMess rejects VLESS ML-KEM as its cipher instead of placing it in the path', () => {
  const T = setup()
  const result = T.shareToOwn(encodeVMess({ v: '2', ps: 'Invalid', add: 'example.com', port: '443', id: UUID, scy: ENC, net: 'ws', path: '/route', tls: 'tls' }))
  assert.ok(result?.err)
  assert.equal(result.node, undefined)
})

test('nonstandard enc query is preserved with a warning, not guessed into path or encryption', () => {
  const T = setup()
  const result = T.shareToOwn(`vless://${UUID}@example.com:443?enc=${ENC}&encryption=none&security=tls&type=ws&path=%2Froute#Vendor-ENC`)
  assert.ok(result?.node, result?.err)
  assert.equal(result.node.encryption, 'none')
  assert.equal(result.node.path, '/route')
  assert.match(result.node.warn, /enc/)
  const query = new URL(T.shareLink({ name: result.node.name, own: true, o: result.node })).searchParams
  assert.equal(query.get('enc'), ENC)
})

test('VLESS editor renders ENC and path in their separate input fields', async () => {
  const T = setup()
  const query = new URLSearchParams({ encryption: ENC, security: 'tls', type: 'xhttp', path: '/enc-route' })
  const result = T.shareToOwn(`vless://${UUID}@example.com:443?${query}#VLESS-ENC`)
  assert.ok(result?.node, result?.err)
  let dialog
  const context = vm.createContext({
    window: {}, OWN: { own: { n: result.node } },
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    selectHTML: id => '<div id="' + id + '"></div>',
    modal: async options => { dialog = options; return null },
  })
  vm.runInContext('(' + T.installOwnEditor.toString() + ')()', context)
  await context.window.editOwn('n')
  assert.equal(dialog.html.match(/id="oencryption"[^>]*value="([^"]*)"/)[1], ENC)
  assert.equal(dialog.html.match(/id="opath"[^>]*value="([^"]*)"/)[1], '/enc-route')
})

test('VLESS ENC sample without a leading WS slash follows Xray normalization without moving ENC', async () => {
  const T = setup()
  const encryption = ENC.replace('.1rtt.', '.0rtt.')
  const query = new URLSearchParams({ encryption, flow: 'xtls-rprx-vision', security: 'tls', sni: '1.1.1.1', fp: 'chrome', type: 'ws', host: '1.1.1.1', path: '-vw' })
  const result = await call(T, '/api/parse-share', { link: `vless://${UUID}@example.com:443?${query}#test` })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.node.encryption, encryption)
  assert.equal(result.body.node.flow, 'xtls-rprx-vision')
  assert.equal(result.body.node.path, '/-vw')
  const save = await call(T, '/api/own', { own: { n: result.body.node } })
  assert.equal(save.status, 200, JSON.stringify(save.body))
  const saved = (await call(T, '/api/own')).body.own.n
  assert.equal(saved.encryption, encryption)
  assert.equal(saved.path, '/-vw')
  const exported = new URL(T.shareLink({ name: saved.name, own: true, o: saved })).searchParams
  assert.equal(exported.get('encryption'), encryption)
  assert.equal(exported.get('path'), '/-vw')
})

for (const format of ['URI', 'JSON']) {
  test('VMess ' + format + ' normalizes a relative WS path independently of its cipher', () => {
    const T = setup()
    const link = format === 'URI'
      ? `vmess://${UUID}@example.com:443?scy=aes-128-gcm&security=tls&type=ws&path=-vw#test`
      : encodeVMess({ v: '2', ps: 'test', add: 'example.com', port: '443', id: UUID, aid: '0', scy: 'aes-128-gcm', net: 'ws', path: '-vw', tls: 'tls' })
    const result = T.shareToOwn(link)
    assert.ok(result?.node, result?.err)
    assert.equal(result.node.cipher, 'aes-128-gcm')
    assert.equal(result.node.path, '/-vw')
    const exported = decodeVMess(T.shareLink({ name: result.node.name, own: true, o: result.node }))
    assert.equal(exported.scy, 'aes-128-gcm')
    assert.equal(exported.path, '/-vw')
  })
}

for (const type of ['vless', 'vmess']) {
  test(type + ' editor save normalizes a relative WS path just like imported links', async () => {
    const T = setup()
    const node = { name: 'Edited', type, s: 'example.com', p: 443, u: UUID, security: 'tls', net: 'ws', path: '-vw', encryption: ENC, cipher: 'aes-128-gcm', flow: '' }
    const saved = await call(T, '/api/own', { own: { n: node } })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const reopened = (await call(T, '/api/own')).body.own.n
    assert.equal(reopened.path, '/-vw')
    assert.equal(reopened[type === 'vless' ? 'encryption' : 'cipher'], type === 'vless' ? ENC : 'aes-128-gcm')
  })
}

test('WS normalization preserves encoded suffixes and never interprets a path as encryption', () => {
  const T = setup()
  for (const [input, expected] of [['', '/'], ['/ready', '/ready'], ['-vw%2Fpart?enc=literal%26value+text', '/-vw%2Fpart?enc=literal%26value+text'], [ENC, '/' + ENC]]) {
    const query = new URLSearchParams({ encryption: 'none', security: 'tls', type: 'ws', path: input })
    const result = T.shareToOwn(`vless://${UUID}@example.com:443?${query}#Path`)
    assert.ok(result?.node, result?.err)
    assert.equal(result.node.encryption, 'none')
    assert.equal(result.node.path, expected)
  }
})

test('WS path normalization does not waive ENC validation or change other transports', () => {
  const T = setup()
  const redacted = T.shareToOwn(`vless://${UUID}@example.com:443?encryption=plus.native.0rtt&security=tls&type=ws&path=-vw#Redacted`)
  assert.ok(redacted?.err)
  assert.equal(redacted.node, undefined)
  const other = T.shareToOwn(`vless://${UUID}@example.com:443?encryption=none&security=tls&type=xhttp&path=-vw#XHTTP`)
  assert.ok(other?.err)
  assert.equal(other.node, undefined)
})
