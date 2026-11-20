const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const yaml = require('js-yaml')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const UUID = '00000000-0000-4000-8000-000000000001'
const PASSWORD = 'synthetic:p@ss+/ %25#'
const copy = value => JSON.parse(JSON.stringify(value))
const base = { name: 'TUIC', type: 'tuic', s: 'safe.example', p: 443, u: UUID, password: PASSWORD, security: 'tls', sni: 'tls.example', insecure: false, udp: true, fp: 'none' }
const clash = extra => ({ name: 'TUIC', type: 'tuic', server: 'safe.example', port: 443, uuid: UUID, password: PASSWORD, sni: 'tls.example', ...extra })
const sb = extra => ({ tag: 'TUIC', type: 'tuic', server: 'safe.example', server_port: 443, uuid: UUID, password: PASSWORD, tls: { enabled: true, server_name: 'tls.example', alpn: ['h3'] }, ...extra })
function setup() {
  const data = { policies: JSON.stringify([{ id: 'all', name: 'All', target: 'all', enabled: true, presets: [], domains: [], keywords: [], processes: [] }]), profiles: JSON.stringify([{ id: 'main', name: 'Main', token: 't'.repeat(32), enabled: true, own: 'all', ups: [], regions: 'all', pols: 'all', policies: 'inherit' }]) }
  const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, Request, Response, Headers, crypto: webcrypto, setTimeout, clearTimeout,
    fetch() { throw new Error('TUIC tests must not connect to real nodes') },
    CONF: { get: async (key, type) => data[key] === undefined ? null : type === 'json' ? JSON.parse(data[key]) : data[key], put: async (key, value) => { data[key] = value } },
  })
  vm.runInContext(source + ';globalThis.T={parseOwnJSON,normalizeOwnNode,shareToOwn,shareLink,ownToSB,ownToKv,toSB,ownCompatibility,genClash,genSB,genSR,genShare,apiRoute,makeCookie,adminHTML}', ctx)
  return { T: ctx.T, data }
}
const { T } = setup()
function parse(value) { return copy(T.parseOwnJSON(typeof value === 'string' ? value : JSON.stringify(value))) }
function success(value) { const r = parse(value); assert.equal(r.ok, true, r.msg); return r.nodes[0] }
function reject(value, field) { const r = parse(value); assert.equal(r.ok, false, JSON.stringify(r)); assert.ok(r.msg.includes(field), r.msg); assert.equal(r.nodes, undefined) }
const uri = (n, basic = false) => T.shareLink({ name: n.name, own: true, o: n }, basic)

test('TUIC v5 URI imports and shares distinct UUID and percent-encoded password', () => {
  const url = `tuic://${UUID}:${encodeURIComponent(PASSWORD)}@[2001:db8::1]:8443?sni=tls.example&alpn=h3&congestion_control=bbr&allow_insecure=1#TUIC`
  const result = T.shareToOwn(url)
  assert.ok(result && result.node, result && result.err)
  const n = result.node
  assert.equal(n.u, UUID)
  assert.equal(n.password, PASSWORD)
  assert.equal(n.s, '2001:db8::1')
  assert.equal(n.insecure, true)
  assert.equal(n.congestionControl, 'bbr')
  const shared = new URL(uri(n))
  assert.equal(decodeURIComponent(shared.username), UUID)
  assert.equal(decodeURIComponent(shared.password), PASSWORD)
  assert.equal(shared.searchParams.get('congestion_control'), 'bbr')
  assert.equal(shared.searchParams.get('allow_insecure'), '1')
  assert.equal(T.shareToOwn(shared.href).node.password, PASSWORD)
})

test('TUIC native, Clash JSON, sing-box JSON and indented YAML fragments import', () => {
  const expected = ['TUIC', 'TUIC', 'TUIC', 'TUIC']
  const values = [base, clash(), sb(), `    - { name: TUIC, type: tuic, server: safe.example, port: 443, uuid: ${UUID}, password: 'synthetic-password', sni: tls.example }`]
  assert.deepEqual(values.map(value => success(value).name), expected)
  const result = parse('"outbounds":[' + JSON.stringify(sb()) + ',{"type":"direct"}],')
  assert.equal(result.ok, true, result.msg)
  assert.equal(result.nodes.length, 1)
  assert.equal(result.nodes[0].u, UUID)
  assert.equal(result.nodes[0].password, PASSWORD)
  assert.equal(result.nodes[0].insecure, false)
})

test('TUIC shared tuning maps milliseconds, false flags and zero-RTT across native formats', () => {
  const n = success(clash({ 'congestion-controller': 'new_reno', 'udp-relay-mode': 'quic', 'heartbeat-interval': 1250, 'reduce-rtt': true, 'disable-sni': false, alpn: ['h3'] }))
  assert.equal(n.heartbeatInterval, 1250)
  assert.equal(n.zeroRtt, true)
  assert.equal(n.disableSni, false)
  assert.equal(n.udpRelayMode, 'quic')
  const outbound = copy(T.ownToSB(n))
  assert.equal(outbound.type, 'tuic')
  assert.equal(outbound.uuid, UUID)
  assert.equal(outbound.password, PASSWORD)
  assert.equal(outbound.congestion_control, 'new_reno')
  assert.equal(outbound.udp_relay_mode, 'quic')
  assert.equal(outbound.heartbeat, '1250ms')
  assert.equal(outbound.zero_rtt_handshake, true)
  assert.equal(outbound.tls.disable_sni, false)
  assert.equal(outbound.tls.utls, undefined)
  const imported = success(outbound)
  assert.equal(imported.heartbeatInterval, 1250)
  const output = yaml.load(T.genClash(false, [], [], {}, { n: imported }, {})).proxies[0]
  assert.equal(output['heartbeat-interval'], 1250)
  assert.equal(output['reduce-rtt'], true)
  assert.equal(output['udp-relay-mode'], 'quic')
  assert.equal(success(JSON.stringify(imported)).password, PASSWORD)
})

test('TUIC sing-box duration and TCP-only network are preserved', () => {
  for (const [duration, ms] of [['1.5s', 1500], ['2m', 120000], ['100ms', 100]]) {
    const n = success(sb({ heartbeat: duration, network: 'tcp', zero_rtt_handshake: false }))
    assert.equal(n.heartbeatInterval, ms)
    assert.equal(n.udp, false)
    assert.equal(n.zeroRtt, false)
    assert.equal(T.ownToSB(n).network, 'tcp')
  }
  reject(sb({ heartbeat: '0.0001ms' }), 'heartbeat')
  reject(sb({ heartbeat: '0s' }), 'heartbeat')
  reject(sb({ network: 'udp' }), 'network')
})

test('TUIC TCP-only restrictions are not silently re-enabled by Mihomo output', () => {
  const n = success(sb({ network: 'tcp' }))
  const config = yaml.load(T.genClash(false, [], [], {}, { n }, {}))
  assert.ok(!(config.proxies || []).some(p => p.name === 'TUIC'))
  assert.ok(T.ownCompatibility(n).some(w => w.format === 'clash' && /UDP/.test(w.reason)))
})

test('TUIC v4 tokens, invalid UUIDs and unsupported connection fields fail with source paths', () => {
  reject(clash({ token: 'synthetic-v4-token' }), 'token')
  reject(clash({ uuid: 'not-a-uuid' }), 'uuid')
  reject(sb({ uuid: '' }), 'uuid')
  reject(sb({ udp_over_stream: true }), 'udp_over_stream')
  reject(clash({ 'request-timeout': 8001 }), 'request-timeout')
  reject({ protocol: 'tuic', settings: {} }, 'protocol')
  const query = `tuic://${UUID}:synthetic@safe.example:443?congestion_control=invalid`
  assert.ok(T.shareToOwn(query).err)
  assert.ok(T.shareToOwn('tuic://synthetic-v4-token@safe.example:443').err)
})

test('TUIC validation prevents invalid TLS, QUIC fingerprint, tuning and wrong JSON types', () => {
  for (const [field, value] of [['security', 'none'], ['fp', 'chrome'], ['congestionControl', 'reno'], ['udpRelayMode', 'tcp'], ['heartbeatInterval', 0], ['heartbeatInterval', 1.5], ['heartbeatInterval', '1000'], ['zeroRtt', 'true'], ['disableSni', 1], ['password', null]]) {
    const r = T.normalizeOwnNode({ ...base, [field]: value })
    assert.ok(r.err, field)
    assert.equal(r.field, field)
  }
  reject(sb({ tls: { enabled: false } }), 'tls.enabled')
  reject(sb({ tls: { enabled: true, alpn: ['h3'], utls: { enabled: true, fingerprint: 'chrome' } } }), 'tls.utls.fingerprint')
  reject(sb({ tls: { enabled: true, alpn: ['h3'], fragment: true } }), 'tls')
})

test('TUIC missing versus explicitly false switches survive editing without injected defaults', () => {
  const n = success(sb())
  for (const field of ['zeroRtt', 'disableSni', 'heartbeatInterval', 'congestionControl', 'udpRelayMode']) assert.equal(n[field], undefined, field)
  const explicit = success(sb({ zero_rtt_handshake: false, tls: { enabled: true, disable_sni: false, alpn: ['h3'] } }))
  assert.equal(explicit.zeroRtt, false)
  assert.equal(explicit.disableSni, false)
  const config = yaml.load(T.genClash(false, [], [], {}, { n: explicit }, {})).proxies[0]
  assert.equal(config['reduce-rtt'], false)
  assert.equal(config['disable-sni'], false)
})

test('TUIC missing ALPN preserves the effective Mihomo h3 default in every output path', () => {
  const n = success(clash())
  assert.deepEqual(n.alpn, ['h3'])
  assert.deepEqual(copy(T.ownToSB(n).tls.alpn), ['h3'])
  assert.deepEqual(copy(T.ownToSB(base).tls.alpn), ['h3'])
  const input = `tuic://${UUID}:synthetic-password@safe.example:443#TUIC`
  assert.deepEqual(copy(T.shareToOwn(input).node.alpn), ['h3'])
  assert.equal(new URL(uri(n)).searchParams.get('alpn'), 'h3')
  const kv = { type: 'tuic', server: 'safe.example', port: '443', uuid: UUID, password: 'synthetic-password' }
  assert.deepEqual(copy(T.toSB({ name: 'Upstream', kv }).tls.alpn), ['h3'])
  assert.equal(new URL(T.shareLink({ name: 'Upstream', kv })).searchParams.get('alpn'), 'h3')
  reject(clash({ alpn: [] }), 'alpn')
  reject(sb({ tls: { enabled: true, alpn: [] } }), 'tls.alpn')
  reject(sb({ tls: { enabled: true } }), 'tls.alpn')
  const custom = success(clash({ alpn: ['tuic-custom', 'h3'] }))
  assert.deepEqual(copy(T.ownToSB(custom).tls.alpn), ['tuic-custom', 'h3'])
})

test('Mihomo disable-sni imports its effective insecure behavior for the existing risk dialog', () => {
  const result = parse(clash({ 'disable-sni': true, 'skip-cert-verify': false }))
  assert.equal(result.ok, true, result.msg)
  assert.equal(result.nodes[0].disableSni, true)
  assert.equal(result.nodes[0].insecure, true)
  assert.ok(result.skipped.some(note => /disable-sni/.test(note)))
  const tls = T.ownToSB(result.nodes[0]).tls
  assert.equal(tls.insecure, true)
  assert.equal(tls.disable_sni, true)
})

test('secure sing-box disable_sni is never silently weakened into Mihomo insecure TLS', () => {
  const n = success(sb({ tls: { enabled: true, server_name: 'tls.example', disable_sni: true, insecure: false, alpn: ['h3'] } }))
  assert.equal(n.insecure, false)
  assert.equal(T.ownToSB(n).tls.insecure, false)
  for (const compatibilityMode of [undefined, 'basic']) {
    const node = { ...n, ...(compatibilityMode ? { compatibilityMode } : {}) }
    const config = yaml.load(T.genClash(false, [], [], {}, { n: node }, {}))
    assert.ok(!(config.proxies || []).some(p => p.name === 'TUIC'))
    assert.ok(!config['proxy-groups'].some(g => (g.proxies || []).includes('TUIC')))
    assert.ok(T.ownCompatibility(node).some(w => w.format === 'clash' && /证书/.test(w.reason)))
  }
})

test('nonportable TUIC tuning blocks strict URI output and offers explicit basic sharing', () => {
  const n = success(sb({ udp_relay_mode: 'quic', heartbeat: '2s', zero_rtt_handshake: true }))
  const before = JSON.stringify(n)
  assert.equal(uri(n), '')
  const basic = new URL(uri(n, true))
  assert.equal(basic.protocol, 'tuic:')
  assert.equal(decodeURIComponent(basic.password), PASSWORD)
  assert.equal(T.ownCompatibility(n).some(w => w.format === 'share' && /TUIC/.test(w.reason)), true)
  assert.equal(JSON.stringify(n), before)
  assert.equal(T.genSR(false, [], [], {}, { n }, {}).includes('TUIC ='), false)
  assert.ok(T.ownCompatibility(n).some(w => w.format === 'shadowrocket'))
})

test('TUIC API save, reopen, edit and generated subscription preserve identity without network calls', async () => {
  const { T: api, data } = setup()
  const call = async body => {
    const cookie = await api.makeCookie()
    const req = new Request('https://test.example/api/own', { method: body ? 'POST' : 'GET', headers: { Cookie: 'sess=' + cookie, Origin: 'https://test.example', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const res = await api.apiRoute(req, new URL(req.url), { waitUntil() {} })
    return { status: res.status, body: await res.json() }
  }
  let r = await call({ own: { tuic: { ...base, congestionControl: 'bbr' } } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(JSON.parse(data.nodes).tuic.password, PASSWORD)
  r = await call()
  assert.equal(r.body.own.tuic.u, UUID)
  assert.ok(r.body.links.tuic.startsWith('tuic://'))
  r = await call({ own: { tuic: { ...r.body.own.tuic, s: 'edited.example', heartbeatInterval: 2000 } } })
  assert.equal(r.status, 200)
  r = await call()
  assert.equal(r.body.own.tuic.s, 'edited.example')
  assert.equal(r.body.links.tuic, '')
  assert.ok(r.body.basicLinks.tuic.startsWith('tuic://'))
  const config = JSON.parse(api.genSB([], [], {}, r.body.own, {}))
  assert.equal(config.outbounds.find(o => o.tag === 'TUIC').heartbeat, '2000ms')
})

test('TUIC browser parser runs independently and rejects polluted or oversize imports', () => {
  const html = T.adminHTML(true, true), marker = 'const parseOwnJSON = (() => {'
  const start = html.indexOf(marker), end = html.indexOf('})();', start) + 5
  const browser = vm.createContext({ TextEncoder, atob, btoa })
  vm.runInContext(html.slice(start, end) + ';globalThis.parse=parseOwnJSON', browser)
  const result = browser.parse(JSON.stringify(sb()))
  assert.equal(result.ok, true, result.msg)
  assert.equal(result.nodes[0].password, PASSWORD)
  reject(JSON.stringify(sb()).replace('"tls":', '"__proto__":{},"tls":'), '__proto__')
  reject(Array.from({ length: 101 }, () => sb()), '100')
})

test('TUIC malformed client option containers produce validation errors, not server exceptions', () => {
  for (const singbox of [null, false, 1, [], { tls: null }, { tls: { fragment: true } }]) {
    let result
    assert.doesNotThrow(() => { result = T.normalizeOwnNode({ ...base, clientOptions: { singbox } }) })
    assert.equal(result.field, 'clientOptions')
    reject({ ...base, clientOptions: { singbox } }, 'clientOptions')
  }
})

test('TUIC empty passwords and literal percent sequences survive all import and sharing paths', () => {
  for (const password of ['', '  spaces  ', '%3A%40+/#']) {
    const n = success(sb({ password }))
    assert.equal(n.password, password)
    assert.equal(T.ownToSB(n).password, password)
    assert.equal(T.shareToOwn(uri(n)).node.password, password)
    assert.equal(success(yaml.load(T.genClash(false, [], [], {}, { n }, {})).proxies[0]).password, password)
  }
})

test('shared TUIC converters never silently drop upstream certificate or transport overrides', () => {
  for (const extra of [{ ip: '192.0.2.1' }, { 'ech-opts': '{ enable: true }' }, { 'udp-over-stream': 'true' }]) {
    const item = { name: 'Upstream', kv: { ...T.ownToKv(base), ...extra } }
    assert.equal(T.toSB(item), null)
    assert.ok(!T.shareLink(item))
  }
  for (const fields of [{ zeroRtt: true }, { udpRelayMode: 'quic' }, { heartbeatInterval: 2500 }, { disableSni: true, insecure: true }]) {
    const item = { name: 'Upstream', kv: T.ownToKv({ ...base, ...fields }) }
    assert.ok(!T.shareLink(item))
    assert.ok(T.shareLink(item, true).startsWith('tuic://'))
  }
  for (const fields of [{ uuid: 'not-uuid' }, { 'udp-relay-mode': 'unverified' }, { 'congestion-controller': 'bbr_meta_v1' }, { 'heartbeat-interval': '0' }]) {
    const item = { name: 'Upstream', kv: { ...T.ownToKv(base), ...fields } }
    assert.equal(T.toSB(item), null)
    assert.ok(!T.shareLink(item))
    assert.ok(!T.shareLink(item, true), 'explicit basic sharing must not admit invalid values')
  }
})

test('upstream TUIC explicit empty ALPN cannot become h3 through strict or basic URI sharing', () => {
  for (const alpn of ['[]', '[ ]', '""', '[""]', '[h3, ""]']) {
    const item = { name: 'Upstream', kv: { ...T.ownToKv(base), alpn } }
    assert.equal(T.toSB(item), null)
    assert.ok(!T.shareLink(item))
    assert.ok(!T.shareLink(item, true))
  }
})
