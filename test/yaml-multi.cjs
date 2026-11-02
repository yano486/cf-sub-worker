const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')

const worker = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
let effects = 0
const forbidden = () => { effects++; throw new Error('Import parsing must remain local') }
const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, btoa, atob, console, fetch: forbidden, CONF: { get: forbidden, put: forbidden, delete: forbidden } })
vm.runInContext(worker, ctx)
vm.runInContext('globalThis.parse = parseOwnJSON', ctx)

const UUID = '11111111-1111-4111-8111-111111111111'
const flow = (name, server) => '{ name: ' + name + ', type: vless, server: ' + server + ',port:443,uuid:' + UUID + ', alterId: 0, cipher: auto, udp: true, flow: null, encryption: none,tls:true, skip-cert-verify: false, servername: tls.example, client-fingerprint: safari, network: ws, ws-opts: { path: "/ws,a#b", headers: { Host: cdn.example, X-Test: "false" } } }'
const A = flow('A', 'first.example')
const B = flow('B', 'second.example')
function parse(text) { return JSON.parse(JSON.stringify(ctx.parse(text))) }
function success(text) {
  const r = parse(text)
  assert.equal(r.ok, true, JSON.stringify(r))
  return r
}
function pair(text) {
  const r = success(text)
  assert.deepEqual(r.nodes.map(n => [n.name, n.s]), [['A', 'first.example'], ['B', 'second.example']])
  for (const n of r.nodes) {
    assert.equal(n.path, '/ws,a#b')
    assert.equal(n.headers['X-Test'], 'false')
    assert.equal(n.p, 443)
    assert.equal(n.security, 'tls')
    assert.equal(n.flow, '')
    assert.equal(n.udp, true)
  }
  return r
}
function reject(text, message) {
  const r = parse(text)
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.nodes, undefined, 'invalid batches cannot expose partially imported nodes')
  assert.match(r.msg, /第 \d+ 个节点/)
  if (message) assert.match(r.msg, message)
  return r
}

test('multiple copied flow nodes retain common root indentation', () => {
  for (const indent of ['  ', '    ', '        ']) pair(indent + '- ' + A + '\n' + indent + '- ' + B)
})

test('complete root flow nodes align after a partial first-line selection', () => {
  for (const indent of [' ', '  ', '    ', '        ']) pair('- ' + A + '\n' + indent + '- ' + B)
  pair('    - ' + A + '\n- ' + B)
})

test('root flow-node batches accept blank lines, comments, BOM, CRLF and document start', () => {
  pair('\uFEFF\r\n# copied proxies\r\n---\r\n\r\n    - ' + A + ' # first\r\n\r\n # between\r\n    - ' + B + '\r\n')
  pair('#copied proxies\n- ' + A + '\n    # comment does not determine node alignment\n    - ' + B)
})

test('wrapped flow maps preserve nested values while root list markers align', () => {
  pair('    - ' + A.replace(',port:', ',\n         port:') + '\n    - ' + B.replace(',port:', ',\n      port:'))
  pair('- ' + A.replace('ws-opts: {', 'ws-opts: {\n  ') + '\n  - ' + B)
})

test('complete top-level proxies flow nodes align without absorbing sibling configuration', () => {
  const r = pair('proxies:\n- ' + A + '\n    - ' + B + '\ndns:\n  enable: true\nrules:\n  - "MATCH,DIRECT"\n')
  assert.ok(r.skipped.some(s => s.includes('$.dns')))
  assert.ok(r.skipped.some(s => s.includes('$.rules')))
  pair('  proxies:\n    - ' + A + '\n      - ' + B + '\n  dns:\n    enable: true\n')
  pair('"proxies":\n- ' + A + '\n  - ' + B)
})

test('normal root and proxies flow lists keep existing behavior', () => {
  pair('- ' + A + '\n- ' + B)
  pair('proxies:\n  - ' + A + '\n  - ' + B)
  pair('proxies: [' + A + ', ' + B + ']')
  pair(JSON.stringify({ proxies: [
    { name: 'A', type: 'vless', server: 'first.example', port: 443, uuid: UUID, tls: true, network: 'ws', flow: '', udp: true, 'ws-opts': { path: '/ws,a#b', headers: { 'X-Test': 'false' } } },
    { name: 'B', type: 'vless', server: 'second.example', port: 443, uuid: UUID, tls: true, network: 'ws', flow: '', udp: true, 'ws-opts': { path: '/ws,a#b', headers: { 'X-Test': 'false' } } },
  ] }))
})

test('alignment never flattens nested maps, nested lists or malformed node fields', () => {
  reject('- ' + A + '\n  ws-opts:\n    path: /different', /缩进/)
  reject('- ' + A + '\n  - name: B\n    type: vless', /缩进/)
  reject('proxies:\n  - ' + A + '\n    ws-opts:\n      path: /different', /缩进/)
  reject('dns:\n  values:\n  - { enabled: true }\n    - { enabled: false }\nproxies:\n  - ' + A, /缩进/)
  reject('nested:\n  proxies:\n  - ' + A + '\n    - ' + B + '\nproxies:\n  - ' + A, /缩进/)
  reject('- name: A\n  type: vless\n    server: first.example\n  port: 443\n  uuid: ' + UUID, /缩进/)
  reject('- ' + A + '\n\t- ' + B, /Tab/)
  reject('- ' + A + ' - ' + B, /值之后/)
})

test('aligned YAML batches still reject duplicate keys, tags, aliases and dangerous properties', () => {
  for (const suffix of ['tls: true, tls: false', 'tls: !!bool true', 'tls: &value true', 'tls: *value', '__proto__: {}', 'constructor: {}', 'prototype: {}', '<<: {tls: true}']) {
    reject('- ' + A + '\n    - { type: vless, server: second.example, port: 443, uuid: ' + UUID + ', ' + suffix + ' }')
  }
  reject('proxies:\n- ' + A + '\n    - ' + B + '\nproxies: []', /重复/)
  reject('- ' + A + '\n    - ' + B + '\n---\nproxies: []', /一个 YAML 文档/)
  assert.equal({}.polluted, undefined)
  assert.equal(effects, 0)
})

test('flow alignment preserves batch size, byte and depth limits', () => {
  const batch = count => Array.from({ length: count }, (_, i) => (i ? '    ' : '') + '- ' + flow('Node' + i, 'node.example')).join('\n')
  assert.equal(success(batch(100)).nodes.length, 100)
  reject(batch(101), /100/)
  const prefix = '- ' + A + '\n    - ' + B + '\n#'
  const boundary = prefix + 'x'.repeat(256 * 1024 - Buffer.byteLength(prefix))
  pair(boundary)
  reject(boundary + 'x', /256 KiB/)
  const nested = depth => 'proxies:\n  - ' + A + '\nmetadata: ' + '['.repeat(depth) + '0' + ']'.repeat(depth)
  assert.equal(success(nested(15)).nodes.length, 1)
  reject(nested(16), /16/)
  reject('- ' + A + '\n    - { type: vless, server: second.example, port: 443, uuid: ' + UUID + ', extra: ' + '['.repeat(18) + '0' + ']'.repeat(18) + ' }', /16/)
  assert.equal(effects, 0)
})

test('fixed multi-node parser stays independently injectable into the browser', () => {
  const browser = vm.createContext({ TextEncoder, normalizeOwnNode: value => ctx.normalizeOwnNode(value) })
  vm.runInContext('globalThis.parse = ' + ctx.parse.toString(), browser)
  const r = browser.parse('    - ' + A + '\n    - ' + B)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.nodes.length, 2)
})
