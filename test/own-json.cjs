const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const worker = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
let sideEffects = 0
const forbidden = () => { sideEffects++; throw new Error('JSON parsing must not access external state') }
const ctx = vm.createContext({
  addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, console,
  fetch: forbidden, CONF: { get: forbidden, put: forbidden, delete: forbidden },
})
vm.runInContext(worker + '\n;globalThis.T={parseOwnJSON:typeof parseOwnJSON === "function" ? parseOwnJSON : null,normalizeOwnNode,ownToKv,ownToSB}', ctx)
const copy = value => JSON.parse(JSON.stringify(value))
const UUID = '00000000-0000-4000-8000-000000000001'
const PK = 'A'.repeat(43)
const native = (extra = {}) => ({ name: 'Test', type: 'vless', s: 'node.example', p: 443, u: UUID, security: 'tls', net: 'tcp', encryption: 'none', flow: '', ...extra })
const clash = (extra = {}) => ({ name: 'Test', type: 'vless', server: 'node.example', port: 443, uuid: UUID, tls: true, ...extra })
const xray = (extra = {}) => ({ tag: 'Test', protocol: 'vless', settings: { vnext: [{ address: 'node.example', port: 443, users: [{ id: UUID, encryption: 'none' }] }] }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'tls.example', allowInsecure: false } }, ...extra })
function parse(value) {
  assert.equal(typeof ctx.T.parseOwnJSON, 'function', 'parseOwnJSON must be implemented')
  return copy(ctx.T.parseOwnJSON(typeof value === 'string' ? value : JSON.stringify(value)))
}
function success(value) {
  const r = parse(value)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(Array.isArray(r.nodes))
  assert.ok(Array.isArray(r.skipped))
  assert.ok(Array.isArray(r.formats))
  return r
}
function reject(value, pathPart) {
  const r = parse(value)
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(r.msg, /第 \d+ 个节点/)
  if (pathPart) assert.ok(r.msg.includes(pathPart), r.msg)
  assert.equal(r.nodes, undefined, 'errors must not leak a partially imported list')
  return r
}

test('native objects and arrays return normalized nodes, never persisted data', () => {
  const r = success([native(), native({ name: 'Second', p: '8443' })])
  assert.equal(r.nodes.length, 2)
  assert.equal(r.nodes[1].p, 8443)
  assert.deepEqual(r.formats, ['本站 JSON'])
  assert.equal(sideEffects, 0)
})

test('native five-protocol advanced parameters are preserved', () => {
  const fixtures = [
    native({ security: 'reality', pk: PK, sid: '00a1', fp: 'chrome', flow: 'xtls-rprx-vision', packetEncoding: 'xudp' }),
    { name: 'HY2', type: 'hysteria2', s: 'hy.example', p: 443, u: 'fake-password', security: 'tls', obfs: 'salamander', opwd: 'fake-obfs', ports: '443,20000-20100', hopInterval: 30, upMbps: 20, downMbps: 50, insecure: false },
    { name: 'SS', type: 'ss', s: 'ss.example', p: 8388, u: 'fake-password', cipher: 'aes-128-gcm', uot: true, uotVersion: 1, plugin: 'v2ray-plugin', pluginOpts: { mode: 'websocket', path: '/ss', tls: true, mux: false } },
    { name: 'VMess', type: 'vmess', s: 'vm.example', p: 443, u: UUID, security: 'tls', cipher: 'auto', alterId: 0, net: 'ws', path: '/ws', headers: { Host: 'cdn.example', 'X-Test': 'value' }, earlyData: 128, earlyDataHeader: 'Sec-WebSocket-Protocol' },
    { name: 'AnyTLS', type: 'anytls', s: 'any.example', p: 443, u: 'fake-password', security: 'tls', idleCheck: 30, idleTimeout: 60, minIdle: 2 },
  ]
  const r = success(fixtures)
  for (let i = 0; i < fixtures.length; i++) for (const [key, value] of Object.entries(fixtures[i])) assert.deepEqual(r.nodes[i][key], value, key)
})

test('native editor defaults round-trip without accepting active inapplicable settings', () => {
  const n = success(native({ path: '/', host: '', serviceName: '', mode: 'auto', pk: '', sid: '', fp: 'chrome', alpn: [], insecure: false, verifyName: '', certSha256: '' })).nodes[0]
  assert.equal(n.type, 'vless')
  assert.equal(n.net, 'tcp')
  assert.equal(success(native({ security: 'none', path: '/', host: '', serviceName: '', mode: 'auto', pk: '', sid: '', fp: 'chrome', alpn: [], insecure: false, verifyName: '', certSha256: '' })).nodes[0].security, 'none')
  reject(native({ net: 'tcp', mode: 'stream-one' }), 'mode')
})

test('new native TLS imports verify certificates unless the input explicitly opts out', () => {
  for (const type of ['hysteria2', 'anytls']) {
    const n = success({ name: type, type, s: 'tls.example', p: 443, u: 'fake-password' }).nodes[0]
    assert.equal(n.security, 'tls')
    assert.equal(n.insecure, false)
    assert.equal(ctx.T.ownToKv(n)['skip-cert-verify'], 'false')
    assert.equal(success({ ...n, insecure: true }).nodes[0].insecure, true)
  }
  assert.equal(success(native({ security: undefined, net: 'ws' })).nodes[0].insecure, false)
})

test('Clash omitted UDP follows Mihomo defaults rather than enabling TCP-proxy UDP', () => {
  assert.equal(success(clash()).nodes[0].udp, false)
  assert.equal(success(clash({ udp: true })).nodes[0].udp, true)
  assert.equal(success({ name: 'HY2', type: 'hysteria2', server: 'hy.example', port: 443, password: 'fake-password' }).nodes[0].udp, true)
  assert.equal(success({ name: 'Any', type: 'anytls', server: 'any.example', port: 443, password: 'fake-password' }).nodes[0].udp, false)
})

test('Clash full config extracts proxies and reports all unimported top-level sections', () => {
  const r = success({ proxies: [clash()], dns: { enable: true }, rules: ['MATCH,DIRECT'], 'proxy-groups': [] })
  assert.equal(r.nodes[0].type, 'vless')
  assert.deepEqual(r.formats, ['Clash/Mihomo JSON'])
  for (const section of ['dns', 'rules', 'proxy-groups']) assert.ok(r.skipped.some(x => x.includes(section)))
})

test('Clash TLS and Reality fields are mapped without a URI round trip', () => {
  const r = success(clash({ servername: 'tls.example', 'skip-cert-verify': true, 'name-cert-verify': 'verify.example', fingerprint: 'ab'.repeat(32), 'client-fingerprint': 'firefox', alpn: ['h2'], 'reality-opts': { 'public-key': PK, 'short-id': '00a1' }, flow: 'xtls-rprx-vision', encryption: 'none', 'packet-encoding': 'xudp', udp: false }))
  const n = r.nodes[0]
  assert.equal(n.security, 'reality')
  assert.equal(n.pk, PK)
  assert.equal(n.sid, '00a1')
  assert.equal(n.sni, 'tls.example')
  assert.equal(n.insecure, true)
  assert.equal(n.verifyName, 'verify.example')
  assert.equal(n.certSha256, 'AB'.repeat(32))
  assert.equal(n.fp, 'firefox')
  assert.deepEqual(n.alpn, ['h2'])
  assert.equal(n.udp, false)
})

test('Clash VMess WebSocket custom headers and early data survive export', () => {
  const n = success(clash({ type: 'vmess', cipher: 'chacha20-poly1305', alterId: 12, network: 'ws', 'ws-opts': { path: '/ws?token=fake', headers: { host: 'cdn.example', 'X-Example': 'value' }, 'max-early-data': 512, 'early-data-header-name': 'Sec-WebSocket-Protocol' } })).nodes[0]
  assert.equal(n.alterId, 12)
  assert.equal(n.cipher, 'chacha20-poly1305')
  assert.deepEqual(n.headers, { Host: 'cdn.example', 'X-Example': 'value' })
  assert.equal(n.earlyData, 512)
  const exported = copy(ctx.T.ownToSB(n))
  assert.equal(exported.transport.headers['X-Example'], 'value')
  assert.equal(exported.transport.max_early_data, 512)
})

test('Clash transport mappings distinguish upgrade, gRPC, h2, HTTP camouflage and XHTTP', () => {
  const cases = [
    [{ network: 'ws', 'ws-opts': { path: '/up', headers: { Host: 'cdn.example' }, 'v2ray-http-upgrade': true } }, { net: 'httpupgrade', path: '/up', host: 'cdn.example' }],
    [{ network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'svc' } }, { net: 'grpc', serviceName: 'svc' }],
    [{ network: 'h2', 'h2-opts': { path: '/h2', host: ['a.example', 'b.example'] } }, { net: 'h2', path: '/h2', host: 'a.example,b.example' }],
    [{ network: 'http', 'http-opts': { path: ['/a', '/b'], headers: { Host: ['a.example', 'b.example'] } } }, { net: 'http', path: '/a,/b', host: 'a.example,b.example' }],
    [{ network: 'xhttp', 'xhttp-opts': { path: '/x', host: 'a.example', mode: 'stream-one' } }, { net: 'xhttp', path: '/x', host: 'a.example', mode: 'stream-one' }],
  ]
  for (const [input, expected] of cases) {
    const n = success(clash(input)).nodes[0]
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(n[key], value, key)
  }
})

test('Clash HY2 bandwidth units and hopping settings map to native numeric fields', () => {
  const n = success({ name: 'HY2', type: 'hysteria2', server: 'hy.example', port: 443, password: 'fake-password', ports: '443/20000-20100', 'hop-interval': 30, up: '30 Mbps', down: '2 MBps', obfs: 'salamander', 'obfs-password': 'fake-obfs', sni: 'tls.example', 'skip-cert-verify': false, alpn: ['h3'] }).nodes[0]
  assert.equal(n.ports, '443,20000-20100')
  assert.equal(n.upMbps, 30)
  assert.equal(n.downMbps, 16)
  assert.equal(n.hopInterval, 30)
  assert.equal(n.opwd, 'fake-obfs')
  assert.equal(n.security, 'tls')
  assert.equal(n.insecure, false)
})

test('Clash SS plugin, UOT version default and AnyTLS pool settings map explicitly', () => {
  const ss = success({ name: 'SS', type: 'ss', server: 'ss.example', port: 8388, password: 'fake-password', cipher: 'aes-128-gcm', 'udp-over-tcp': true, plugin: 'obfs', 'plugin-opts': { mode: 'tls', host: 'cdn.example' } }).nodes[0]
  assert.equal(ss.uotVersion, 1, 'Mihomo UOT default must not become ownToKv default 2')
  assert.deepEqual(ss.pluginOpts, { mode: 'tls', host: 'cdn.example' })
  const any = success({ name: 'Any', type: 'anytls', server: 'any.example', port: 443, password: 'fake-password', 'idle-session-check-interval': 10, 'idle-session-timeout': 60, 'min-idle-session': 2 }).nodes[0]
  assert.equal(any.idleCheck, 10)
  assert.equal(any.idleTimeout, 60)
  assert.equal(any.minIdle, 2)
})

test('Xray single outbound and full config skip only non-proxy outbounds', () => {
  const r = success({ outbounds: [{ tag: 'direct', protocol: 'freedom' }, xray(), { protocol: 'blackhole' }, { protocol: 'dns' }], routing: { rules: [] }, dns: {}, inbounds: [] })
  assert.equal(r.nodes.length, 1)
  assert.deepEqual(r.formats, ['Xray JSON'])
  for (const word of ['freedom', 'blackhole', 'dns', 'routing', 'inbounds']) assert.ok(r.skipped.some(s => s.includes(word)), word)
})

test('Xray vnext/users expand and preserve UUID and per-user flow', () => {
  const r = success(xray({ settings: { vnext: [{ address: 'first.example', port: 443, users: [{ id: UUID, encryption: 'none', flow: 'xtls-rprx-vision' }, { id: 'second-user', encryption: 'none' }] }, { address: 'second.example', port: 8443, users: [{ id: 'third-user', encryption: 'none' }] }] } }))
  assert.equal(r.nodes.length, 3)
  assert.deepEqual(r.nodes.map(n => n.u), [UUID, 'second-user', 'third-user'])
  assert.equal(r.nodes[0].flow, 'xtls-rprx-vision')
  assert.equal(r.nodes[1].flow, '')
  assert.equal(r.nodes[2].s, 'second.example')
  assert.equal(new Set(r.nodes.map(n => n.name)).size, 3)
})

test('current Xray flat settings, method and Reality password aliases are supported', () => {
  const n = success(xray({ settings: { address: 'flat.example', port: 443, id: UUID, encryption: 'none', flow: 'xtls-rprx-vision' }, streamSettings: { method: 'raw', security: 'reality', realitySettings: { serverName: 'tls.example', fingerprint: 'chrome', password: PK, shortId: '0011' } } })).nodes[0]
  assert.equal(n.s, 'flat.example')
  assert.equal(n.pk, PK)
  assert.equal(n.sid, '0011')
  assert.equal(n.net, 'tcp')
  assert.equal(n.security, 'reality')
})

test('Xray VMess and Shadowsocks map their protocol-specific fields', () => {
  const vmess = success({ tag: 'VM', protocol: 'vmess', settings: { vnext: [{ address: 'vm.example', port: 443, users: [{ id: UUID, security: 'aes-128-gcm', alterId: 0 }] }] }, streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/vm', headers: { Host: 'cdn.example', 'X-Test': 'value' } } } }).nodes[0]
  assert.equal(vmess.type, 'vmess')
  assert.equal(vmess.cipher, 'aes-128-gcm')
  assert.equal(vmess.headers['X-Test'], 'value')
  const ss = success({ tag: 'SS', protocol: 'shadowsocks', settings: { servers: [{ address: 'ss.example', port: 8388, method: 'chacha20-poly1305', password: 'fake-password' }] } }).nodes[0]
  assert.equal(ss.type, 'ss')
  assert.equal(ss.cipher, 'chacha20-ietf-poly1305')
  assert.equal(ss.security, 'none')
})

test('Xray WS, HTTPUpgrade, gRPC, legacy h2, XHTTP and HTTP camouflage map distinctly', () => {
  const cases = [
    [{ network: 'ws', wsSettings: { path: '/ws', host: 'cdn.example', headers: { 'X-Test': 'value' } } }, { net: 'ws', path: '/ws', host: 'cdn.example' }],
    [{ network: 'httpupgrade', httpupgradeSettings: { path: '/up', host: 'cdn.example' } }, { net: 'httpupgrade', path: '/up' }],
    [{ network: 'grpc', grpcSettings: { serviceName: 'svc' } }, { net: 'grpc', serviceName: 'svc' }],
    [{ network: 'http', httpSettings: { path: '/h2', host: ['a.example', 'b.example'] } }, { net: 'h2', path: '/h2', host: 'a.example,b.example' }],
    [{ network: 'xhttp', xhttpSettings: { path: '/x', host: 'a.example', mode: 'stream-up' } }, { net: 'xhttp', path: '/x', mode: 'stream-up' }],
    [{ network: 'tcp', tcpSettings: { header: { type: 'http', request: { path: ['/a', '/b'], headers: { Host: ['a.example'] } } } } }, { net: 'http', path: '/a,/b', host: 'a.example' }],
  ]
  for (const [transport, expected] of cases) {
    const n = success(xray({ streamSettings: { security: 'tls', ...transport } })).nodes[0]
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(n[key], value)
  }
})

test('Xray default WS Host follows each server address instead of the TLS SNI', () => {
  const settings = { vnext: [
    { address: 'first.example', port: 443, users: [{ id: UUID, encryption: 'none' }] },
    { address: 'second.example', port: 443, users: [{ id: UUID, encryption: 'none' }] },
  ] }
  const r = success(xray({ settings, streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: 'tls.example' }, wsSettings: { path: '/', host: '' } } }))
  assert.deepEqual(r.nodes.map(n => n.host), ['first.example', 'second.example'])
  for (const n of r.nodes) assert.ok(ctx.T.ownToKv(n)['ws-opts'].includes(n.s))
  const n = success(xray({ streamSettings: { network: 'ws', security: 'tls', tlsSettings: { serverName: 'tls.example' }, wsSettings: { path: '/', headers: { Host: 'explicit.example' } } } })).nodes[0]
  assert.equal(n.host, 'explicit.example')
  const upgrade = success(xray({ streamSettings: { network: 'httpupgrade', security: 'tls', tlsSettings: { serverName: 'tls.example' }, httpupgradeSettings: { path: '/', host: '' } } })).nodes[0]
  assert.equal(upgrade.host, 'node.example')
})

test('Xray TLS certificate pin, verification name, ALPN and allowInsecure are never dropped', () => {
  const n = success(xray({ streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'tls.example', allowInsecure: true, verifyPeerCertByName: 'verify.example', pinnedPeerCertSha256: 'ab'.repeat(32), alpn: ['h2'], fingerprint: 'firefox' } } })).nodes[0]
  assert.equal(n.insecure, true)
  assert.equal(n.certSha256, 'AB'.repeat(32))
  assert.equal(n.verifyName, 'verify.example')
  assert.deepEqual(n.alpn, ['h2'])
  assert.equal(n.fp, 'firefox')
})

test('Xray WebSocket early-data path syntax becomes native earlyData without a stale ed parameter', () => {
  const n = success(xray({ streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/ws?token=fake&ed=2560' } } })).nodes[0]
  assert.equal(n.path, '/ws?token=fake')
  assert.equal(n.earlyData, 2560)
  assert.equal(n.earlyDataHeader, 'Sec-WebSocket-Protocol')
  reject(xray({ streamSettings: { network: 'httpupgrade', security: 'tls', httpupgradeSettings: { path: '/up?ed=128' } } }), 'path')
})

test('Xray rejects encoded or duplicate ed query keys without changing unrelated percent encoding', () => {
  for (const path of ['/ws?%65d=128', '/ws?e%64=128', '/ws?ed=128&ed=256', '/ws?ed=128&%65d=256']) {
    reject(xray({ streamSettings: { network: 'ws', security: 'tls', wsSettings: { path } } }), 'path')
  }
  const path = '/ws?token=a%26b%3Dc&literal=%65%64'
  assert.equal(success(xray({ streamSettings: { network: 'ws', security: 'tls', wsSettings: { path } } })).nodes[0].path, path)
})

test('external validation errors retain the original field paths and never truncate names', () => {
  assert.ok(reject(clash({ servername: {} })).msg.includes('$.servername'))
  assert.ok(reject({ name: 'SS', type: 'ss', server: 'ss.example', port: 8388, password: 'fake-password', cipher: 'aes-128-gcm', plugin: 'v2ray-plugin', 'plugin-opts': { tls: 'true' } }).msg.includes('$.plugin-opts.tls'))
  reject(clash({ name: 'x'.repeat(33) }), 'name')
  reject(native({ name: 'x'.repeat(33) }), 'name')
})

test('unsupported protocols fail rather than silently disappearing', () => {
  reject({ proxies: [clash(), { type: 'trojan', name: 'unsupported', server: 'x.example', port: 443, password: 'fake-password' }] }, 'type')
  for (const protocol of ['trojan', 'hysteria2', 'anytls', 'wireguard']) reject({ protocol, settings: {} }, 'protocol')
  const recognized = success({ outbounds: [{ type: 'vless', tag: 'singbox', server: 'x.example', server_port: 443, uuid: UUID }] })
  assert.equal(recognized.nodes[0].type, 'vless')
  assert.equal(recognized.nodes[0].s, 'x.example')
})

test('unknown fields report their exact path, including nested transport and TLS options', () => {
  const cases = [
    [native({ unknown: true }), 'unknown'],
    [native({ type: 'ss', cipher: 'aes-128-gcm', net: 'tcp' }), 'net'],
    [clash({ 'ws-opts': { path: '/' } }), 'ws-opts'],
    [clash({ network: 'ws', 'ws-opts': { 'v2ray-http-upgrade-fast-open': true } }), 'v2ray-http-upgrade-fast-open'],
    [clash({ network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'svc', 'grpc-user-agent': 'agent' } }), 'grpc-user-agent'],
    [clash({ network: 'xhttp', 'xhttp-opts': { path: '/', 'no-grpc-header': true } }), 'no-grpc-header'],
    [xray({ mux: { enabled: true } }), 'mux'],
    [xray({ streamSettings: { network: 'ws', security: 'tls', wsSettings: { heartbeatPeriod: 10 } } }), 'heartbeatPeriod'],
    [xray({ streamSettings: { security: 'tls', tlsSettings: { certificates: ['fake-cert'] } } }), 'certificates'],
    [xray({ streamSettings: { security: 'tls', tlsSettings: { pinnedPeerCertificateChainSha256: ['fake-chain-pin'] } } }), 'pinnedPeerCertificateChainSha256'],
    [xray({ streamSettings: { network: 'grpc', security: 'tls', grpcSettings: { serviceName: 'svc', multiMode: true } } }), 'multiMode'],
  ]
  for (const [input, expected] of cases) reject(input, expected)
})

test('protocol-inapplicable fields and ignored security parameters are rejected', () => {
  reject(native({ net: 'grpc', headers: { 'X-Test': 'value' } }), 'headers')
  reject(native({ net: 'tcp', earlyData: 100 }), 'earlyData')
  reject(native({ security: 'none', certSha256: 'ab'.repeat(32) }), 'certSha256')
  reject(clash({ tls: false, 'skip-cert-verify': true }), 'skip-cert-verify')
  reject(clash({ servername: 'a.example', sni: 'b.example' }), 'sni')
  reject(clash({ 'reality-opts': { 'public-key': PK }, tls: false }), 'tls')
  reject(xray({ streamSettings: { security: 'none', tlsSettings: { allowInsecure: true } } }), 'tlsSettings')
})

test('lossy list/header flattening and unsupported pins fail explicitly', () => {
  reject(clash({ network: 'h2', 'h2-opts': { path: ['/a', '/b'] } }), 'path')
  reject(clash({ network: 'http', 'http-opts': { path: ['/a,b'] } }), 'path')
  reject(clash({ network: 'http', 'http-opts': { headers: { 'X-Test': ['a', 'b'] } } }), 'X-Test')
  reject(xray({ streamSettings: { security: 'tls', tlsSettings: { pinnedPeerCertSha256: 'ab'.repeat(32) + ',' + 'cd'.repeat(32) } } }), 'pinnedPeerCertSha256')
  reject(xray({ streamSettings: { security: 'tls', tlsSettings: { verifyPeerCertByName: 'a.example,b.example' } } }), 'verifyPeerCertByName')
})

test('malformed field types do not silently coerce or drop credentials and booleans', () => {
  reject(native({ u: { password: 'secret-not-to-echo' } }), 'u')
  reject(clash({ tls: 'true' }), 'tls')
  reject(clash({ network: 'ws', 'ws-opts': { headers: { Host: ['a.example'] } } }), 'Host')
  reject({ name: 'SS', type: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-128-gcm', password: 'fake-password', plugin: 'v2ray-plugin', 'plugin-opts': { tls: 'true' } }, 'tls')
  reject(xray({ settings: { vnext: [{ address: 'node.example', port: 443, users: [{ id: UUID, encryption: 'none', level: 9 }] }] } }), 'level')
})

test('security validation failures are atomic and do not echo supplied secret values', () => {
  const secret = 'secret-value-never-echo-123'
  const r = reject([native(), native({ u: secret, security: 'reality', pk: secret })], 'pk')
  assert.ok(!r.msg.includes(secret))
  assert.match(r.msg, /第 2 个节点/)
})

test('JSON parser rejects malformed, empty, ambiguous and non-object containers', () => {
  for (const input of ['', '{', 'null', 'true', '1', '"node"', '[]', '{}', '{"proxies":{}}', '{"outbounds":null}']) reject(input)
  reject({ proxies: [clash()], outbounds: [xray()] })
})

test('dangerous property names are rejected at every depth including skipped configuration', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    reject('{"proxies":[' + JSON.stringify(clash()) + '],"dns":{"nested":{"' + key + '":{}}}}', key)
  }
  assert.equal({}.polluted, undefined)
})

test('lone UTF-16 surrogates cannot create nodes that later fail URI export', () => {
  for (const value of ['bad\ud800pass', 'bad\udfffpass']) {
    reject({ name: 'HY2', type: 'hysteria2', s: 'hy.example', p: 443, u: value }, 'u')
    reject({ proxies: [clash()], ignored: { value } }, 'value')
    reject('{"proxies":[' + JSON.stringify(clash()) + '],"ignored":{"bad\\ud800key":true}}', 'ignored')
  }
  const password = 'fake-\ud83d\ude80-password'
  assert.equal(success({ name: 'HY2', type: 'hysteria2', s: 'hy.example', p: 443, u: password }).nodes[0].u, password)
})

test('UTF-8 size and nesting limits apply before mapping or external effects', () => {
  reject(JSON.stringify({ padding: '中'.repeat(90000) }), '256')
  let nested = {}
  for (let i = 0; i < 18; i++) nested = { nested }
  reject({ proxies: [clash()], dns: nested }, '16')
  reject('{"proxies":[' + JSON.stringify(clash()) + '],"dns":{"number":1e400}}', 'number')
  assert.equal(sideEffects, 0)
})

test('UTF-8 byte and depth limits accept the exact documented boundary', () => {
  const base = JSON.stringify({ proxies: [clash()], ignored: '' })
  const input = JSON.stringify({ proxies: [clash()], ignored: 'x'.repeat(256 * 1024 - Buffer.byteLength(base)) })
  assert.equal(Buffer.byteLength(input), 256 * 1024)
  assert.equal(success(input).nodes.length, 1)
  reject(input + ' ', '256')
  let nested = 'leaf'
  for (let i = 0; i < 15; i++) nested = { nested }
  assert.equal(success({ proxies: [clash()], ignored: nested }).nodes.length, 1)
  reject({ proxies: [clash()], ignored: { nested } }, '16')
})

test('100-node limit includes expanded Xray users and returns no partial success', () => {
  assert.equal(success(Array.from({ length: 100 }, (_, i) => native({ name: 'Node ' + i }))).nodes.length, 100)
  reject(Array.from({ length: 101 }, (_, i) => native({ name: 'Node ' + i })), '100')
  const users = Array.from({ length: 101 }, (_, i) => ({ id: 'user-' + i, encryption: 'none' }))
  reject(xray({ settings: { vnext: [{ address: 'node.example', port: 443, users }] } }), '100')
})

test('parser is self-contained apart from normalizeOwnNode for browser injection', () => {
  assert.equal(typeof ctx.T.parseOwnJSON, 'function')
  const browser = vm.createContext({ TextEncoder, normalizeOwnNode: value => ctx.T.normalizeOwnNode(value) })
  vm.runInContext('globalThis.parse=' + ctx.T.parseOwnJSON.toString(), browser)
  const result = copy(browser.parse(JSON.stringify(clash())))
  assert.equal(result.ok, true)
  assert.equal(result.nodes[0].s, 'node.example')
  assert.equal(sideEffects, 0)
})
