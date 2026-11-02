const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const worker = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
let effects = 0
const forbidden = () => { effects++; throw new Error('Parser must remain local') }
const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, console, fetch: forbidden, CONF: { get: forbidden, put: forbidden, delete: forbidden } })
vm.runInContext(worker, ctx)
vm.runInContext('globalThis.T={parseOwnJSON,normalizeOwnNode,ownToSB,ownToKv}', ctx)
const copy = value => JSON.parse(JSON.stringify(value))
const UUID = '00000000-0000-4000-8000-000000000002'
const sb = extra => ({ type: 'vless', server: 'safe.example', server_port: 443, uuid: UUID, tls: { enabled: true, server_name: 'tls.example' }, ...extra })
const xr = extra => ({ protocol: 'vless', settings: { address: 'safe.example', port: 443, id: UUID, encryption: 'none', email: '' }, streamSettings: { network: 'tcp', security: 'tls' }, ...extra })
const cl = extra => ({ type: 'vless', name: 'Clash', server: 'safe.example', port: 443, uuid: UUID, tls: true, ...extra })
function parse(value) { return copy(ctx.T.parseOwnJSON(typeof value === 'string' ? value : JSON.stringify(value))) }
function success(value) { const r = parse(value); assert.equal(r.ok, true, JSON.stringify(r)); return r }
function reject(value, field) { const r = parse(value); assert.equal(r.ok, false, JSON.stringify(r)); assert.match(r.msg, /第 \d+ 个节点/); assert.equal(r.nodes, undefined); if (field) assert.ok(r.msg.includes(field), r.msg); return r }

test('JSON key fragments and trailing commas are repaired only outside strings', () => {
  const r = success('"outbounds":[' + JSON.stringify(xr()) + ',],')
  assert.equal(r.nodes[0].s, 'safe.example')
  assert.equal(success('[' + JSON.stringify(sb({ tag: 'literal ,} ,] string' })) + ',]').nodes[0].name, 'literal ,} ,] string')
  reject('{outbounds: []}')
  reject('{"outbounds": [1,,]}')
})

test('outbounds independently detect mixed Xray and sing-box entries and skip direct siblings', () => {
  const r = success({ outbounds: [xr(), { type: 'direct' }, sb(), { protocol: 'freedom' }, { protocol: 'blackhole' }], dns: {} })
  assert.equal(r.nodes.length, 2)
  assert.ok(r.formats.includes('sing-box JSON'))
  for (const part of ['direct', 'freedom', 'blackhole', 'dns']) assert.ok(r.skipped.some(x => x.includes(part)), part)
})

test('all five supported sing-box protocols import without a configuration wrapper', () => {
  const r = success([
    sb(), sb({ type: 'vmess', security: 'auto', alter_id: 0 }),
    { type: 'shadowsocks', server: 'ss.example', server_port: '8388', method: 'aes-128-gcm', password: 'synthetic-password' },
    { type: 'anytls', server: 'any.example', server_port: 443, password: 'synthetic-password', idle_session_check_interval: '30s', idle_session_timeout: '60s', min_idle_session: 2, tls: { enabled: true, insecure: true, fragment: true, record_fragment: true, fragment_fallback_delay: '500ms' } },
    { type: 'hysteria2', server: 'hy.example', server_ports: ['35000:39000', '40000:40000'], hop_interval: '30s', password: 'synthetic-password', tls: { enabled: true } },
  ])
  assert.deepEqual(r.nodes.map(n => n.type), ['vless', 'vmess', 'ss', 'anytls', 'hysteria2'])
  assert.ok(r.nodes.every(n => n.name))
  assert.equal(r.nodes[2].p, 8388)
  assert.equal(r.nodes[3].insecure, true)
  assert.equal(r.nodes[3].idleCheck, 30)
  assert.deepEqual(r.nodes[3].clientOptions, { singbox: { tls: { fragment: true, record_fragment: true, fragment_fallback_delay: '500ms' } } })
  assert.equal(r.nodes[4].p, 35000)
  assert.equal(r.nodes[4].ports, '35000-39000,40000')
  assert.equal(r.nodes[4].hopInterval, 30)
  assert.equal(r.nodes[4].insecure, false)
})

test('sing-box TLS, transport and protocol fields map with exact values', () => {
  const n = success(sb({ transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example', 'X-Test': 'value' }, max_early_data: 256, early_data_header_name: 'Sec-WebSocket-Protocol' }, packet_encoding: 'xudp', tls: { enabled: true, server_name: 'tls.example', insecure: false, alpn: ['http/1.1'], utls: { enabled: true, fingerprint: 'firefox' } } })).nodes[0]
  assert.equal(n.net, 'ws')
  assert.deepEqual(n.headers, { Host: 'cdn.example', 'X-Test': 'value' })
  assert.equal(n.earlyData, 256)
  assert.equal(n.fp, 'firefox')
  assert.equal(n.packetEncoding, 'xudp')
  const reality = success(sb({ flow: 'xtls-rprx-vision', tls: { enabled: true, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'A'.repeat(43), short_id: '0011' } } })).nodes[0]
  assert.equal(reality.security, 'reality')
  assert.equal(reality.pk, 'A'.repeat(43))
})

test('sing-box WS default Host preserves server authority instead of the distinct TLS SNI', () => {
  for (const headers of [undefined, { 'X-Test': 'value' }]) {
    const n = success(sb({ transport: { type: 'ws', path: '/ws', ...(headers ? { headers } : {}) } })).nodes[0]
    assert.equal(n.host, 'safe.example:443')
    assert.equal(copy(ctx.T.ownToSB(n)).transport.headers.Host, 'safe.example:443')
    assert.equal(JSON.parse(ctx.T.ownToKv(n)['ws-opts']).headers.Host, 'safe.example:443')
    if (headers) assert.equal(copy(ctx.T.ownToSB(n)).transport.headers['X-Test'], 'value')
  }
  const explicit = success(sb({ transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example' } } })).nodes[0]
  assert.equal(explicit.host, 'cdn.example')
  assert.equal(copy(ctx.T.ownToSB(explicit)).transport.headers.Host, 'cdn.example')
})

test('sing-box HTTPUpgrade missing Host follows TLS name or plain server authority', () => {
  for (const [tls, expected] of [[{ enabled: true, server_name: 'tls.example' }, 'tls.example'], [{ enabled: true }, 'safe.example'], [{ enabled: false }, 'safe.example:443']]) {
    const n = success(sb({ tls, transport: { type: 'httpupgrade', path: '/up' } })).nodes[0]
    assert.equal(n.host, expected)
    assert.equal(copy(ctx.T.ownToSB(n)).transport.host, expected)
  }
  const explicit = success(sb({ transport: { type: 'httpupgrade', path: '/up', host: 'cdn.example', headers: { Host: 'cdn.example', 'X-Test': 'value' } } })).nodes[0]
  assert.equal(explicit.host, 'cdn.example')
  assert.equal(explicit.headers.Host, 'cdn.example')
  assert.equal(copy(ctx.T.ownToSB(explicit)).transport.host, 'cdn.example')
  reject(sb({ transport: { type: 'httpupgrade', path: '/up', host: 'different.example', headers: { Host: 'cdn.example' } } }), 'transport.host')
})

test('sing-box protocol inference requires unique structural cues', () => {
  const n = success({ server: 'any.example', server_port: 443, password: 'synthetic-password', idle_session_timeout: '60s', tls: { enabled: true } }).nodes[0]
  assert.equal(n.type, 'anytls')
  reject({ server: 'ambiguous.example', server_port: 443, password: 'synthetic-password', tls: { enabled: true } }, 'type')
  reject({ settings: { address: 'ambiguous.example', port: 443, id: UUID } }, 'protocol')
  reject(sb({ type: 'trojan' }), 'type')
})

test('sing-box invalid fields keep source paths and never silently drop options', () => {
  reject(sb({ tls: { enabled: true, fragment: 'true' } }), 'tls.fragment')
  reject(sb({ transport: { type: 'ws', path: '/', heartbeat: 5 } }), 'transport.heartbeat')
  reject(sb({ server_port: '4.43e2' }), 'server_port')
  reject(sb({ unknown: 'synthetic-secret' }), 'unknown')
  reject({ type: 'hysteria2', server: 'hy.example', server_ports: ['39000:35000'], password: 'synthetic-password' }, 'server_ports')
  reject({ type: 'hysteria2', server: 'hy.example', server_ports: ['35000:39000'], hop_interval: '500ms', password: 'synthetic-password' }, 'hop_interval')
})

test('Xray preserves ECH and finalmask while recording only inactive mux as skipped', () => {
  const n = success(xr({ mux: { enabled: false, concurrency: -1 }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { echConfigList: 'synthetic-ech', echForceQuery: 'full', allowInsecure: true }, finalmask: { tcp: [{ type: 'header-custom', settings: { request: ['synthetic-header'] } }] } } }))
  assert.deepEqual(n.nodes[0].clientOptions, { xray: { tlsSettings: { echConfigList: 'synthetic-ech', echForceQuery: 'full' }, finalmask: { tcp: [{ type: 'header-custom', settings: { request: ['synthetic-header'] } }] } } })
  assert.equal(n.nodes[0].insecure, true)
  assert.ok(n.skipped.some(s => s.includes('mux')))
  reject(xr({ mux: { enabled: true } }), 'mux')
  reject(xr({ mux: { enabled: false, concurrency: 8 } }), 'concurrency')
  reject(xr({ streamSettings: { security: 'tls', tlsSettings: { echForceQuery: 1 } } }), 'echForceQuery')
})

test('native clientOptions round-trip through parser and normalizer without a source-specific leak', () => {
  const n = success(xr({ streamSettings: { security: 'tls', tlsSettings: { echConfigList: 'synthetic-ech' } } })).nodes[0]
  assert.deepEqual(success(n).nodes[0].clientOptions, { xray: { tlsSettings: { echConfigList: 'synthetic-ech' } } })
})

test('client extension errors keep original source paths and inactive values do not invent extensions', () => {
  reject(xr({ streamSettings: { security: 'tls', finalmask: { tcp: {} } } }), 'streamSettings.finalmask.tcp')
  reject(xr({ streamSettings: { security: 'tls', finalmask: { unexpected: [] } } }), 'streamSettings.finalmask.unexpected')
  reject(sb({ tls: { enabled: true, fragment: true, fragment_fallback_delay: 'invalid' } }), 'tls.fragment_fallback_delay')
  assert.equal(success(xr({ streamSettings: { security: 'tls', tlsSettings: { echConfigList: '', echForceQuery: '' }, finalmask: {} } })).nodes[0].clientOptions, undefined)
})

test('transport finalmask is not mistaken for an outer TLS requirement', () => {
  const n = success(xr({ streamSettings: { security: 'none', network: 'tcp', finalmask: { tcp: [{ type: 'header-custom', settings: { request: ['synthetic-header'] } }] } } })).nodes[0]
  assert.equal(n.security, 'none')
  assert.equal(n.clientOptions.xray.finalmask.tcp[0].type, 'header-custom')
})

test('Clash exporter defaults are ignored with notes, active wrong-protocol settings fail', () => {
  const n = success(cl({ alterId: 0, cipher: 'auto', flow: null, network: 'ws', 'ws-opts': { path: '/', headers: { Host: 'cdn.example' } } }))
  assert.equal(n.nodes[0].flow, '')
  for (const field of ['alterId', 'cipher', 'flow']) assert.ok(n.skipped.some(s => s.includes(field)))
  reject(cl({ alterId: 1 }), 'alterId')
  reject(cl({ cipher: 'aes-128-gcm' }), 'cipher')
})

test('Clash flow YAML supports unquoted keys, nested values, quotes, and multiple lines', () => {
  const single = '- {name: Flow, type: vless, server: safe.example, port: "443", uuid: "' + UUID + '", alterId: 0, cipher: auto, flow: null, tls: true, network: ws, ws-opts: {path: "/a,b#c", headers: {Host: cdn.example, X-Test: "true"}}}'
  const n = success(single).nodes[0]
  assert.equal(n.path, '/a,b#c')
  assert.equal(n.headers['X-Test'], 'true')
  assert.equal(n.p, 443)
  const multi = 'proxies:\n  - {name: Multi, type: vless, server: safe.example,\n     port: 443, uuid: "' + UUID + '", tls: true, alpn: [h2, "http/1.1"]}'
  assert.deepEqual(success(multi).nodes[0].alpn, ['h2', 'http/1.1'])
})

test('Clash block YAML preserves strings, booleans, arrays, and nested maps', () => {
  const yaml = 'proxies:\n  - name: Block\n    type: vless\n    server: safe.example\n    port: 443\n    uuid: ' + UUID + '\n    tls: true\n    network: ws\n    alpn:\n      - h2\n      - http/1.1\n    ws-opts:\n      path: /ws\n      headers:\n        Host: cdn.example\n        X-Test: "false"\ndns:\n  enable: true\n'
  const r = success(yaml)
  assert.equal(r.nodes[0].headers['X-Test'], 'false')
  assert.deepEqual(r.nodes[0].alpn, ['h2', 'http/1.1'])
  assert.ok(r.skipped.some(s => s.includes('dns')))
  reject(yaml.replace('tls: true', 'tls: "true"'), 'tls')
})

test('common indentationless YAML sequences stay attached to their parent key', () => {
  const yaml = '---\nproxies:\n- name: \'It\'\'s quoted\' # comment\n  type: ss\n  server: ss.example\n  port: 8388\n  cipher: aes-128-gcm\n  password: "synthetic#password"\ndns:\n  enable: true\n'
  const r = success(yaml)
  assert.equal(r.nodes[0].name, "It's quoted")
  assert.equal(r.nodes[0].u, 'synthetic#password')
  assert.ok(r.skipped.some(s => s.includes('dns')))
})

test('unsafe YAML features and duplicate keys are rejected without executing anything', () => {
  for (const suffix of ['tls: !!bool true', 'tls: &enabled true', 'tls: *enabled', '<<: {tls: true}', 'tls: true, tls: false', '__proto__: {}']) reject('- {name: Unsafe, type: vless, server: safe.example, port: 443, uuid: ' + UUID + ', ' + suffix + '}')
  reject('- name: Duplicate\n  type: vless\n  type: vmess\n  server: safe.example\n  port: 443\n  uuid: ' + UUID)
  reject('({type:"vless",s:fetch("https://invalid.example")})')
  assert.equal(effects, 0)
  assert.equal({}.polluted, undefined)
})

test('adaptive formats retain byte, depth, node, prototype and surrogate boundaries', () => {
  assert.equal(success(Array.from({ length: 100 }, (_, i) => sb({ tag: 'Node ' + i }))).nodes.length, 100)
  reject(Array.from({ length: 101 }, (_, i) => sb({ tag: 'Node ' + i })), '100')
  reject('proxies: [' + ' '.repeat(256 * 1024) + ']', '256')
  reject('proxies: [' + '['.repeat(18) + '1' + ']'.repeat(18) + ']', '16')
  reject('"outbounds":[' + JSON.stringify(sb()) + '], "dns":{"constructor":{}},', 'constructor')
  reject(sb({ tag: 'bad\ud800name' }), 'tag')
  const secret = 'synthetic-secret-not-to-echo'
  assert.ok(!reject(sb({ tls: { enabled: true, fragment: secret } })).msg.includes(secret))
  assert.equal(effects, 0)
})

test('adaptive parser can run injected with only normalizer and standard TextEncoder', () => {
  const browser = vm.createContext({ TextEncoder, normalizeOwnNode: value => ctx.T.normalizeOwnNode(value) })
  vm.runInContext('globalThis.parse=' + ctx.T.parseOwnJSON.toString(), browser)
  assert.equal(browser.parse(JSON.stringify(sb())).ok, true)
  assert.equal(browser.parse('- {type: ss, server: ss.example, port: 8388, cipher: aes-128-gcm, password: synthetic-password}').ok, true)
})
