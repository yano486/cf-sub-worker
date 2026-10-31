const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const yaml = require('js-yaml')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const UUID = '00000000-0000-4000-8000-000000000001'
const PK = 'A'.repeat(43)
const policies = [{ id: 'all', name: 'Policy', target: 'all', strict: false, enabled: true, presets: [], domains: [], keywords: [], processes: [] }]
const copy = x => JSON.parse(JSON.stringify(x))
const fixtures = {
  vless: { name: 'VLESS', type: 'vless', s: 'v.example.com', p: 443, u: UUID, security: 'tls', net: 'grpc', serviceName: 'service/test', flow: '', encryption: 'none', sni: 's.example.com', fp: 'firefox', alpn: ['h2'], insecure: false, udp: true, packetEncoding: 'xudp' },
  hysteria2: { name: 'HY2', type: 'hysteria2', s: 'h.example.com', p: 443, u: 'user:p@ss:/+#', security: 'tls', sni: 'h.example.com', alpn: ['h3'], insecure: false, ports: '443,20000-20100', hopInterval: 45, upMbps: 20, downMbps: 80, obfs: 'salamander', opwd: 'obfs;pass', udp: true },
  ss: { name: 'SS', type: 'ss', s: '2001:db8::1', p: 8388, u: ' a:p@ss+/;= ', cipher: 'aes-128-gcm', udp: true, uot: true, uotVersion: 2, plugin: 'v2ray-plugin', pluginOpts: { mode: 'websocket', host: 'cdn.example.com', path: '/ss', tls: true, mux: false } },
  vmess: { name: 'VMess', type: 'vmess', s: 'm.example.com', p: 443, u: UUID, cipher: 'chacha20-poly1305', alterId: 0, security: 'tls', net: 'ws', path: '/ws', host: 'cdn.example.com', headers: { 'X-Test': 'value' }, earlyData: 512, earlyDataHeader: 'Sec-WebSocket-Protocol', sni: 'tls.example.com', fp: 'chrome', alpn: ['h2', 'http/1.1'], insecure: true, udp: true },
  anytls: { name: 'AnyTLS', type: 'anytls', s: 'a.example.com', p: 443, u: 'a:p@ss+/;=', security: 'tls', sni: 'a.example.com', alpn: ['h2'], fp: 'firefox', insecure: false, idleCheck: 15, idleTimeout: 60, minIdle: 2, udp: true },
}

function setup() {
  const kv = { policies: JSON.stringify(policies), profiles: JSON.stringify([{ id: 'main', name: 'Main', token: 't'.repeat(32), enabled: true, own: 'all', ups: [], regions: 'all', pols: 'all', policies: 'inherit' }]) }
  const ctx = vm.createContext({
    addEventListener() {}, crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal, structuredClone, setTimeout, clearTimeout, console,
    CONF: { get: async (k, t) => kv[k] === undefined ? null : t === 'json' ? JSON.parse(kv[k]) : kv[k], put: async (k, v) => { kv[k] = v }, delete: async k => { delete kv[k] } },
    fetch: async () => { throw new Error('Tests must not fetch upstream nodes') },
  })
  vm.runInContext(source + '\n;globalThis.T={apiRoute,makeCookie,shareToOwn,shareLink,ownToSB,genClash,genSB,genSR,genShare,renderSub,adminHTML,parseShareLine,parseFlow,unquote,installOwnEditor}', ctx)
  return { T: ctx.T, kv }
}
async function call(T, route, body) {
  const cookie = await T.makeCookie()
  const req = new Request('https://test.example' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: 'sess=' + cookie, 'Content-Type': 'application/json', Origin: 'https://test.example' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const response = await T.apiRoute(req, new URL(req.url), { waitUntil() {} })
  return { status: response.status, body: await response.json() }
}

for (const [type, fixture] of Object.entries(fixtures)) {
  test(type + ': create, get and edit preserve all configured options', async () => {
    const { T, kv } = setup()
    let r = await call(T, '/api/own', { own: { node: fixture } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.own.node.type, type)
    const saved = JSON.parse(kv.nodes).node
    for (const [key, value] of Object.entries(fixture)) assert.deepEqual(saved[key], value, key)
    r = await call(T, '/api/own')
    assert.equal(r.body.own.node.type, type)
    assert.ok(r.body.links.node.startsWith(type + '://'))
    const edited = { ...saved, s: 'changed.example.net', p: 9443 }
    r = await call(T, '/api/own', { own: { node: edited } })
    assert.equal(r.status, 200)
    assert.equal(JSON.parse(kv.nodes).node.s, 'changed.example.net')
    assert.equal(JSON.parse(kv.nodes).node.p, 9443)
  })
  test(type + ': valid Clash output and no dangling groups', () => {
    const { T } = setup()
    const cfg = yaml.load(T.genClash(false, [], policies, {}, { node: fixture }, {}))
    const node = cfg.proxies.find(n => n.name === fixture.name)
    assert.equal(node.type, type)
    assert.equal(node.server, fixture.s)
    const valid = new Set([...cfg.proxies.map(n => n.name), ...cfg['proxy-groups'].map(n => n.name), 'DIRECT', 'REJECT'])
    for (const group of cfg['proxy-groups']) for (const name of group.proxies || []) assert.ok(valid.has(name), name)
  })
  test(type + ': valid sing-box output and no dangling groups', () => {
    const { T } = setup()
    const cfg = JSON.parse(T.genSB([], policies, {}, { node: fixture }, {}))
    const node = cfg.outbounds.find(n => n.tag === fixture.name)
    assert.ok(node, 'missing outbound')
    assert.equal(node.type, type === 'ss' ? 'shadowsocks' : type)
    assert.equal(node.server, fixture.s)
    const valid = new Set(cfg.outbounds.map(n => n.tag))
    for (const group of cfg.outbounds) for (const tag of group.outbounds || []) assert.ok(valid.has(tag), tag)
  })
}

test('TLS, ALPN and transport fields map to client-native names', () => {
  const { T } = setup()
  const v = T.ownToSB(fixtures.vless)
  assert.deepEqual(copy(v.transport), { type: 'grpc', service_name: 'service/test' })
  assert.deepEqual(copy(v.tls.alpn), ['h2'])
  assert.equal(v.tls.utls.fingerprint, 'firefox')
  const m = T.ownToSB(fixtures.vmess)
  assert.equal(m.security, 'chacha20-poly1305')
  assert.equal(m.tls.insecure, true)
  assert.equal(m.transport.headers['X-Test'], 'value')
  assert.equal(m.transport.max_early_data, 512)
  const a = T.ownToSB(fixtures.anytls)
  assert.equal(a.idle_session_check_interval, '15s')
  assert.equal(a.idle_session_timeout, '60s')
  assert.equal(a.min_idle_session, 2)
  const h = T.ownToSB(fixtures.hysteria2)
  assert.equal(h.hop_interval, '45s')
  assert.equal(h.up_mbps, 20)
  assert.equal(h.down_mbps, 80)
  assert.equal(h.tls.insecure, false)
  const s = T.ownToSB(fixtures.ss)
  assert.deepEqual(copy(s.udp_over_tcp), { enabled: true, version: 2 })
})

test('all five URI imports retain protocol, credentials and supported transport fields', () => {
  const { T } = setup()
  for (const fixture of Object.values(fixtures)) {
    const uri = T.shareLink({ name: fixture.name, own: true, o: fixture })
    assert.ok(uri, fixture.type)
    const imported = T.shareToOwn(uri)
    assert.ok(imported && imported.node, fixture.type + ': ' + JSON.stringify(imported))
    for (const key of ['name', 'type', 's', 'p', 'u']) assert.equal(String(imported.node[key]), String(fixture[key]), fixture.type + '.' + key)
    if (fixture.type === 'vless') assert.equal(imported.node.serviceName, fixture.serviceName)
    if (fixture.type === 'vmess') {
      assert.equal(imported.node.cipher, fixture.cipher)
      assert.deepEqual(copy(imported.node.alpn), fixture.alpn)
      assert.equal(imported.node.insecure, true)
    }
    if (fixture.type === 'ss') assert.equal(imported.node.pluginOpts.path, '/ss')
  }
})

test('SS2022 uses percent-encoded plain userinfo, with correct key validation', async () => {
  const { T } = setup()
  const node = { ...fixtures.ss, cipher: '2022-blake3-aes-128-gcm', u: Buffer.alloc(16, 251).toString('base64'), plugin: '', pluginOpts: {}, uot: false }
  const r = await call(T, '/api/own', { own: { s: node } })
  assert.equal(r.status, 200)
  const link = T.shareLink({ name: node.name, own: true, o: node })
  assert.match(link, /^ss:\/\/2022-blake3-aes-128-gcm:/)
  assert.equal(T.shareToOwn(link).node.u, node.u)
  const bad = await call(T, '/api/own', { own: { s: { ...node, u: 'short' } } })
  assert.equal(bad.status, 400)
})

test('TCP HTTP camouflage is not accidentally converted to HTTP/2', () => {
  const { T } = setup()
  for (const type of ['vless', 'vmess']) {
    const node = { ...fixtures[type], net: 'http', path: '/camouflage', host: 'front.example.com' }
    const clash = yaml.load(T.genClash(false, [], policies, {}, { n: node }, {})).proxies[0]
    assert.equal(clash.network, 'http')
    assert.deepEqual(clash['http-opts'].path, ['/camouflage'])
    assert.deepEqual(clash['http-opts'].headers.Host, ['front.example.com'])
    assert.equal(T.ownToSB(node), null)
    const back = T.shareToOwn(T.shareLink({ name: node.name, own: true, o: node }))
    assert.equal(back.node.net, 'http')
  }
})

test('VMess XHTTP URI preserves path, Host and mode', () => {
  const { T } = setup()
  const node = { ...fixtures.vmess, net: 'xhttp', path: '/uplink', host: 'front.example.com', mode: 'stream-up' }
  const link = T.shareLink({ name: node.name, own: true, o: node })
  const back = T.shareToOwn(link).node
  for (const key of ['net', 'path', 'host', 'mode']) assert.equal(back[key], node[key], key)
})

for (const [type, fixture] of Object.entries(fixtures)) {
  test(type + ': disabling UDP is honored or explicitly reported for every output', async () => {
    const { T } = setup()
    const node = { ...fixture, udp: false }
    assert.equal(T.ownToSB(node).network, 'tcp')
    const clash = yaml.load(T.genClash(false, [], policies, {}, { n: node }, {})).proxies[0]
    assert.equal(clash.udp, false)
    const r = await call(T, '/api/own', { own: { n: node } })
    assert.equal(r.status, 200)
    assert.ok(r.body.compatibility.n.some(w => w.format === 'share' && w.field === 'udp'))
    const sr = T.genSR(false, [], policies, {}, { n: node }, {})
    const line = sr.split('\n').find(line => line.startsWith(node.name + ' = '))
    if (line) assert.ok(!line.includes('udp=true'), line)
  })
}

test('Shadowrocket preserves disabled TLS and explicit certificate verification choices', () => {
  const { T } = setup()
  for (const type of ['vless', 'vmess']) {
    const plain = { ...fixtures[type], security: 'none', net: 'tcp', flow: '' }
    const output = T.genSR(false, [], policies, {}, { n: plain }, {})
    const line = output.split('\n').find(line => line.startsWith(plain.name + ' = '))
    assert.ok(line && !line.includes('tls=true'), line)
    const tls = { ...plain, security: 'tls', insecure: true }
    const sr = T.genSR(false, [], policies, {}, { n: tls }, {})
    assert.match(sr.split('\n').find(line => line.startsWith(tls.name + ' = ')), /insecure=true/)
  }
})

test('HY2 imports ALPN and rejects incomplete authentication/unsupported URI fields explicitly', () => {
  const { T } = setup()
  const imported = T.shareToOwn('hy2://synthetic@h.example.com:443?sni=h.example.com&alpn=h3#HY')
  assert.deepEqual(copy(imported.node.alpn), ['h3'])
  for (const uri of [
    'hy2://synthetic@h.example.com:443?obfs=salamander',
    'vless://' + UUID + '@v.example.com:443?security=tls&ech=unsupported',
    'ss://' + Buffer.from('aes-128-gcm:synthetic').toString('base64') + '@s.example.com:443/?plugin=v2ray-plugin%3Bunknown-required%3Dvalue',
  ]) {
    const r = T.shareToOwn(uri)
    assert.ok(r && (r.err || r.node?.warn), 'import must not silently discard parameters')
  }
})

test('unsupported URI enum values are refused, while additional VMess JSON fields survive with a warning', () => {
  const { T } = setup()
  for (const query of ['security=xtls','security=tls&flow=unsupported','security=tls&type=xhttp&mode=not-a-mode','security=tls&packetEncoding=unknown','security=tls&type=tcp&headerType=unknown']) {
    assert.ok(T.shareToOwn('vless://' + UUID + '@v.example.com:443?' + query).err, query)
  }
  const j = { v:'2',ps:'VM',add:'vm.example.com',port:'443',id:UUID,aid:'0',net:'ws',path:'/ws',tls:'tls',unknownRequired:'yes' }
  const imported = T.shareToOwn('vmess://' + Buffer.from(JSON.stringify(j)).toString('base64'))
  assert.ok(imported.node && !imported.err)
  assert.equal(imported.node.importExtras.vmess.unknownRequired,'yes')
  assert.match(imported.node.warn,/unknownRequired/)
})

test('SR cannot change special-character credentials or inject additional configuration lines', async () => {
  const { T } = setup()
  for (const u of ['a"b,c', 'a\\b,c', 'first\r\n[Rule]']) {
    const node = { ...fixtures.anytls, u }
    const r = await call(T, '/api/own', { own: { n: node } })
    if (r.status === 400) continue
    assert.ok(r.body.compatibility.n.some(w => w.format === 'shadowrocket' && w.field === 'u'))
    assert.ok(!T.genSR(false, [], policies, {}, { n: node }, {}).split('\n').some(line => line.startsWith(node.name + ' = ')))
  }
})

test('unrelated legacy nodes are byte-for-byte preserved when another node is added', async () => {
  const { T, kv } = setup()
  const old = { name: 'OldH', type: 'hysteria2', s: 'old.example.com', p: 443, u: 'old', obfs: 'salamander', opwd: '' }
  kv.nodes = JSON.stringify({ old })
  const r = await call(T, '/api/own', { own: { old, added: fixtures.ss } })
  assert.equal(r.status, 200)
  assert.equal(JSON.stringify(JSON.parse(kv.nodes).old), JSON.stringify(old))
})

test('explicit empty packet encoding is not replaced with xudp', () => {
  const { T } = setup()
  assert.ok(!('packet_encoding' in T.ownToSB({ ...fixtures.vless, packetEncoding: '' })))
})

test('HTTPUpgrade carries headers and reports unsupported early-data', async () => {
  const { T } = setup()
  const node = { ...fixtures.vmess, net: 'httpupgrade' }
  assert.equal(T.ownToSB(node).transport.headers['X-Test'], 'value')
  const r = await call(T, '/api/own', { own: { n: node } })
  assert.ok(r.body.compatibility.n.some(w => w.format === 'singbox' && w.field === 'earlyData'))
})

for (const [field, value] of [['minIdle', true], ['idleTimeout', null], ['idleCheck', []]]) {
  test('numeric JSON type is checked: ' + field, async () => {
    const { T } = setup()
    assert.equal((await call(T, '/api/own', { own: { n: { ...fixtures.anytls, [field]: value } } })).status, 400)
  })
}

test('reopening preserves explicit security choices and the selected fingerprint', async () => {
  const { T } = setup()
  for (const node of [{ ...fixtures.anytls, fp: 'chrome_psk' }, { ...fixtures.hysteria2, security: undefined, insecure: false }, { ...fixtures.vmess, security: undefined }, { ...fixtures.vless, security: undefined, net:'ws', packetEncoding:undefined }]) {
    let form
    const selections = {}
    const ctx = vm.createContext({ window: {}, OWN: { own: { n: node } }, esc: String,
      selectHTML: (id, options, value) => { selections[id] = { options, value }; return '<div id="' + id + '"></div>' },
      modal: async options => { form = options; return null },
    })
    vm.runInContext('(' + T.installOwnEditor.toString() + ')()', ctx)
    await ctx.window.editOwn('n')
    if (node.fp === 'chrome_psk') assert.ok(selections.ofp.options.some(o => o.v === 'chrome_psk'))
    if (node.type === 'hysteria2') assert.ok(!/id="oinsecure"[^>]*checked/.test(form.html))
    if (node.type === 'vmess') assert.equal(selections.osecurity.value, 'none')
    if (node.type === 'vless') assert.equal(selections.opacket.value, 'xudp')
  }
})

for (const net of ['tcp', 'ws', 'httpupgrade', 'grpc', 'h2', 'xhttp']) {
  test('VLESS transport ' + net + ' is not forced to Reality', async () => {
    const { T } = setup()
    const node = { ...fixtures.vless, net, path: '/custom', host: 'cdn.example.com', mode: 'packet-up' }
    const r = await call(T, '/api/own', { own: { v: node } })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.own.v.security, 'tls')
    const link = T.shareLink({ name: node.name, own: true, o: node })
    assert.match(link, /security=tls/)
    assert.ok(!link.includes('security=reality'))
    if (net === 'xhttp') {
      const u = new URL(link)
      assert.equal(u.searchParams.get('path'), '/custom')
      assert.equal(u.searchParams.get('mode'), 'packet-up')
    }
  })
}

const invalidCases = [
  ['unknown protocol', { ...fixtures.ss, type: 'unknown' }],
  ['fractional port', { ...fixtures.ss, p: 443.5 }],
  ['zero port', { ...fixtures.ss, p: 0 }],
  ['overlarge port', { ...fixtures.ss, p: 65536 }],
  ['port suffix', { ...fixtures.ss, p: '443oops' }],
  ['unsafe server', { ...fixtures.ss, s: 'x\nproxies:' }],
  ['bad Reality key', { ...fixtures.vless, security: 'reality', net: 'tcp', pk: 'bad', sid: 'ab' }],
  ['bad Reality short id', { ...fixtures.vless, security: 'reality', net: 'tcp', pk: PK, sid: 'abc' }],
  ['unsupported obfuscation', { ...fixtures.hysteria2, obfs: 'unknown' }],
  ['mixed missing obfuscation credential', { ...fixtures.hysteria2, opwd: '' }],
  ['bad hopping range', { ...fixtures.hysteria2, ports: '500-100' }],
  ['negative bandwidth', { ...fixtures.hysteria2, upMbps: -1 }],
  ['negative sessions', { ...fixtures.anytls, minIdle: -1 }],
  ['AnyTLS without TLS', { ...fixtures.anytls, security: 'none' }],
  ['bad plugin', { ...fixtures.ss, plugin: 'not-a-plugin' }],
  ['bad header', { ...fixtures.vmess, headers: { 'X-Bad': 'a\r\nb' } }],
  ['unsafe encryption', { ...fixtures.vless, encryption: 'bad\nvalue' }],
]
for (const [label, fixture] of invalidCases) {
  test('invalid save is atomic: ' + label, async () => {
    const { T, kv } = setup()
    kv.nodes = JSON.stringify({ old: { name: 'Old', type: 'hysteria2', s: 'old.example.com', p: 443, u: 'old' } })
    const before = kv.nodes
    const result = await call(T, '/api/own', { own: { new: fixture } })
    assert.equal(result.status, 400, JSON.stringify(result.body))
    assert.equal(kv.nodes, before)
  })
}

test('unknown data cannot poison object prototypes', async () => {
  const { T } = setup()
  const own = JSON.parse('{"__proto__":' + JSON.stringify(fixtures.ss) + '}')
  assert.equal((await call(T, '/api/own', { own })).status, 400)
  assert.equal({}.u, undefined)
})

test('legacy VLESS and HY2 remain readable without rewriting their stored records', async () => {
  const { T, kv } = setup()
  const old = {
    v: { name: 'LegacyV', type: 'vless', s: 'old.example.com', p: 443, u: UUID, net: 'tcp', sni: 'example.com', pk: PK, sid: 'ab', flow: 'xtls-rprx-vision' },
    h: { name: 'LegacyH', type: 'hysteria2', s: 'oldh.example.com', p: 8443, u: 'oldpass', sni: 'oldh.example.com' },
  }
  kv.nodes = JSON.stringify(old)
  const before = kv.nodes
  const r = await call(T, '/api/own')
  assert.equal(r.status, 200)
  assert.equal(kv.nodes, before)
  assert.match(r.body.links.v, /security=reality/)
  assert.match(r.body.links.h, /insecure=1/)
  assert.equal(T.ownToSB(old.h).tls.insecure, true)
})

test('unsupported output options are surfaced and unsupported nodes leave no dangling references', async () => {
  const { T, kv } = setup()
  kv.nodes = JSON.stringify({ a: fixtures.anytls, x: { ...fixtures.vless, name: 'XHTTP', net: 'xhttp', path: '/x', mode: 'auto' } })
  const own = await call(T, '/api/own')
  assert.ok(own.body.compatibility.a.some(w => w.format === 'share' && w.field === 'idleCheck'))
  assert.ok(own.body.compatibility.x.some(w => w.format === 'singbox'))
  const preview = await call(T, '/api/preview?pf=main&fmt=singbox')
  assert.ok(preview.body.warnings.some(w => w.name === 'XHTTP'))
  const cfg = JSON.parse(preview.body.body)
  assert.ok(!cfg.outbounds.some(n => n.tag === 'XHTTP'))
  const valid = new Set(cfg.outbounds.map(n => n.tag))
  for (const n of cfg.outbounds) for (const target of n.outbounds || []) assert.ok(valid.has(target), target)
})

test('editor includes five protocols, an advanced field section and compatibility notes', () => {
  const { T } = setup()
  const html = T.adminHTML(true, true)
  assert.ok(/AnyTLS/.test(html), 'AnyTLS option missing')
  assert.ok(/VMess/.test(html), 'VMess option missing')
  assert.ok(/Shadowsocks/.test(html), 'SS option missing')
  assert.ok(/高级配置/.test(html), 'advanced section missing')
  assert.ok(/idle|空闲会话/.test(html), 'session controls missing')
  assert.ok(/兼容|支持情况/.test(html), 'compatibility notes missing')
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1])
})

test('editor helpers produce actual inputs for create and reopen, including advanced options', async () => {
  const { T } = setup()
  for (const type of Object.keys(fixtures)) {
    let captured
    const context = vm.createContext({
      window: {}, OWN: { own: { saved: fixtures[type] } },
      esc: value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
      selectHTML: (id, opts, value) => '<div id="' + id + '" data-value="' + String(value) + '"></div>',
      modal: async options => { captured = options; return null },
    })
    vm.runInContext('(' + T.installOwnEditor.toString() + ')()', context)
    await context.window.editOwn('saved')
    assert.equal(captured.title, '编辑自有节点')
    for (const id of ['on','os','op','ou','ot','ofp','oalpn','opk','osid','ocipher','oalter','oports','ohop','oup','odown','oplugin','opluginhost','oidlecheck','oidletimeout','ominidle']) assert.ok(captured.html.includes('id="' + id + '"'), type + '.' + id)
    assert.ok(!captured.html.includes('id="oimp"'), 'existing records must not change their identity through import')
    assert.match(captured.html, /value="saved" disabled/)
    await context.window.editOwn(null)
    assert.ok(captured.html.includes('id="oimp"'), 'new records have URI import')
  }
})
