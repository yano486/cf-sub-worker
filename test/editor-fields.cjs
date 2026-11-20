const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa,
  fetch() { throw new Error('Editor fields must not contact upstream services') },
})
vm.runInContext(source + `;globalThis.T={
  ownHeaderRows:typeof ownHeaderRows==='function'?ownHeaderRows:null,
  collectOwnHeaders:typeof collectOwnHeaders==='function'?collectOwnHeaders:null,
  ownECHState:typeof ownECHState==='function'?ownECHState:null,
  applyOwnECH:typeof applyOwnECH==='function'?applyOwnECH:null,
  normalizeOwnNode,ownToKv,ownToSB,shareLink,shareToOwn,ownCompatibility,adminHTML
}`, ctx)
const T = ctx.T
const copy = value => JSON.parse(JSON.stringify(value))
const ECH = 'ech.example+https://dns.example/dns-query?value=a%2Bb&mode=full'
const node = { name: 'Editor', type: 'vless', s: 'safe.example', p: 443, u: '11111111-2222-3333-4444-555555555555', security: 'tls', net: 'ws', path: '/ws', host: 'cdn.example', flow: '', encryption: 'none', insecure: false }
function rows(n) { assert.equal(typeof T.ownHeaderRows, 'function'); return copy(T.ownHeaderRows(n)) }
function collect(input, host = '') { assert.equal(typeof T.collectOwnHeaders, 'function'); return copy(T.collectOwnHeaders(input, host)) }
function state(n) { assert.equal(typeof T.ownECHState, 'function'); const result = copy(T.ownECHState(n)); assert.ok(!result.err, result.err); return result }
function apply(n, draft, value, acknowledged = false) { assert.equal(typeof T.applyOwnECH, 'function'); return copy(T.applyOwnECH(draft, state(n), value, acknowledged)) }

test('header rows load legacy Host, UA and arbitrary header names without mutating the node', () => {
  const n = { ...node, headers: { Host: 'cdn.example', 'User-Agent': 'Synthetic UA', 'X-Custom': '  preserve value  ' } }
  const before = JSON.stringify(n)
  assert.deepEqual(rows(n), [{ name: 'Host', value: 'cdn.example' }, { name: 'User-Agent', value: 'Synthetic UA' }, { name: 'X-Custom', value: '  preserve value  ' }])
  assert.equal(JSON.stringify(n), before)
  assert.deepEqual(rows(node), [{ name: 'Host', value: 'cdn.example' }])
})

test('several header rows generate one object and one consistent Host value', () => {
  const r = collect([{ name: 'host', value: 'cdn.example' }, { name: 'User-Agent', value: '  UA  ' }, { name: 'Origin', value: 'https://origin.example' }, { name: 'X-Empty', value: '' }], 'cdn.example')
  assert.ok(!r.err, r.err)
  assert.deepEqual(r.headers, { Host: 'cdn.example', 'User-Agent': '  UA  ', Origin: 'https://origin.example', 'X-Empty': '' })
  assert.equal(r.host, 'cdn.example')
  const saved = T.normalizeOwnNode({ ...node, ...r }).node
  const outbound = T.ownToSB(saved)
  assert.equal(outbound.transport.headers.Host, 'cdn.example')
  assert.equal(outbound.transport.headers['User-Agent'], '  UA  ')
})

test('blank new rows and blank Host use existing defaults without creating empty headers', () => {
  assert.deepEqual(collect([{ name: '', value: '' }, { name: 'Host', value: '' }]), { headers: {}, host: '' })
  assert.equal(collect([{ name: '', value: 'unfinished' }]).row, 0)
  assert.equal(collect([{ name: 'User-Agent', value: '' }]).headers['User-Agent'], '')
})

test('duplicate header names are case-insensitive and Host conflicts never silently overwrite', () => {
  for (const entries of [[{ name: 'Host', value: 'a.example' }, { name: 'host', value: 'b.example' }], [{ name: 'User-Agent', value: 'A' }, { name: 'user-agent', value: 'B' }]]) {
    const r = collect(entries)
    assert.ok(r.err)
    assert.equal(r.row, 1)
  }
  const r = collect([{ name: 'Host', value: 'a.example' }], 'b.example')
  assert.ok(r.err)
  assert.equal(r.row, 0)
})

test('header rows reject invalid names, injection, dangerous keys and excessive counts', () => {
  for (const [name, value] of [['Bad Header', 'value'], ['X:Bad', 'value'], ['__proto__', 'value'], ['constructor', 'value'], ['prototype', 'value'], ['X-Test', 'a\r\nb'], ['X-Test', '\0'], ['X-Test', 'x'.repeat(4097)]]) assert.ok(collect([{ name, value }]).err)
  assert.ok(collect(Array.from({ length: 31 }, (_, i) => ({ name: 'X-' + i, value: 'value' }))).err)
})

test('thirty existing headers plus a separate Host round-trip without truncation', () => {
  const headers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['X-' + i, 'value-' + i]))
  const original = { ...node, headers }, normalized = T.normalizeOwnNode(original)
  assert.ok(normalized.node, normalized.err)
  const loaded = rows(normalized.node)
  assert.equal(loaded.length, 31)
  const result = collect(loaded, 'cdn.example')
  assert.ok(!result.err, result.err)
  assert.deepEqual(result.headers, headers)
  assert.equal(result.host, 'cdn.example')
  assert.ok(T.normalizeOwnNode({ ...node, ...result }).node)
})

test('ECH query values leave the generic JSON view but other extension fields stay intact', () => {
  const n = { ...node, importExtras: { query: [['ech', ECH], ['keep', 'unchanged']], vmess: { extra: 'untouched' } } }
  const before = JSON.stringify(n), r = state(n)
  assert.equal(r.value, ECH)
  assert.equal(r.conflict, false)
  assert.deepEqual(r.extras, { query: [['keep', 'unchanged']], vmess: { extra: 'untouched' } })
  assert.equal(JSON.stringify(n), before)
})

test('ECH native client settings get their own input while query policy and finalmask remain', () => {
  const n = { ...node, clientOptions: { xray: { tlsSettings: { echConfigList: ECH, echForceQuery: 'full' }, finalmask: { tcp: [] } } } }
  const r = state(n)
  assert.equal(r.value, ECH)
  assert.equal(r.hasConfig, true)
  assert.deepEqual(r.clientOptions, { xray: { tlsSettings: { echForceQuery: 'full' }, finalmask: { tcp: [] } } })
  const changed = apply(n, { ...node, clientOptions: r.clientOptions }, 'changed.example')
  assert.equal(changed.node.clientOptions.xray.tlsSettings.echConfigList, 'changed.example')
  assert.equal(changed.node.clientOptions.xray.tlsSettings.echForceQuery, 'full')
  assert.deepEqual(apply(n, { ...node, clientOptions: r.clientOptions }, ECH).node.clientOptions, n.clientOptions)
})

test('ECH update and clear preserve unrelated extras and do not mutate the original draft', () => {
  const n = { ...node, importExtras: { query: [['ech', ECH], ['keep', 'value']] } }, r = state(n)
  const draft = { ...node, importExtras: r.extras }, before = JSON.stringify(draft)
  const changed = apply(n, draft, 'changed.example')
  assert.deepEqual(changed.node.importExtras.query, [['keep', 'value'], ['ech', 'changed.example']])
  const cleared = apply(n, draft, '')
  assert.deepEqual(cleared.node.importExtras.query, [['keep', 'value']])
  assert.equal(JSON.stringify(draft), before)
  const only = { ...node, importExtras: { query: [['ech', ECH]] } }
  assert.equal(apply(only, node, '').node.importExtras, undefined)
})

test('new TUIC ECH uses the existing field schema and shares the complete value once', () => {
  const n = { name: 'TUIC', type: 'tuic', s: 'safe.example', p: 443, u: node.u, password: 'synthetic', security: 'tls', alpn: ['h3'], insecure: false }
  const r = apply(n, n, ECH)
  assert.ok(r.node, r.err)
  assert.equal(r.node.ech, undefined, 'no new API schema is required')
  const normalized = T.normalizeOwnNode(r.node)
  assert.ok(normalized.node, normalized.err)
  const link = T.shareLink({ name: n.name, own: true, o: normalized.node }), url = new URL(link)
  assert.equal(url.searchParams.get('ech'), ECH)
  assert.equal(url.searchParams.getAll('ech').length, 1)
  assert.equal(state(T.shareToOwn(link).node).value, ECH)
  assert.ok(T.ownCompatibility(normalized.node).some(w => w.format === 'singbox' && /ech/.test(w.reason)))
})

test('VMess imported ECH is displayed and written back into its existing JSON extension', () => {
  const n = { ...node, type: 'vmess', importExtras: { vmess: { ech: ECH, extra: 'keep' } } }, r = state(n)
  assert.equal(r.value, ECH)
  assert.deepEqual(r.extras, { vmess: { extra: 'keep' } })
  const changed = apply(n, { ...n, importExtras: r.extras }, 'changed.example')
  assert.deepEqual(changed.node.importExtras.vmess, { extra: 'keep', ech: 'changed.example' })
})

test('conflicting ECH sources block untouched saves and require an explicit input change', () => {
  const n = { ...node, clientOptions: { xray: { tlsSettings: { echConfigList: 'a.example' } } }, importExtras: { query: [['ech', 'b.example']] } }, r = state(n)
  assert.equal(r.conflict, true)
  const draft = { ...node }
  assert.ok(apply(n, draft, 'a.example').err)
  const resolved = apply(n, draft, 'selected.example', true)
  assert.equal(resolved.node.clientOptions.xray.tlsSettings.echConfigList, 'selected.example')
  assert.deepEqual(resolved.node.importExtras.query, [['ech', 'selected.example']])
  assert.equal(apply(n, draft, '', true).node.clientOptions, undefined)
})

test('ECH hidden JSON conflicts, malformed extension containers and invalid text fail visibly', () => {
  const n = { ...node }, draft = { ...node, importExtras: { query: [['ech', 'different.example']] } }
  assert.ok(apply(n, draft, ECH).err)
  for (const value of [null, 'a\nb', '\ud800', 'x'.repeat(32769)]) assert.ok(apply(n, n, value).err)
  for (const importExtras of [null, [], { query: {} }, { query: [['ech']] }, { vmess: null }]) {
    const r = T.ownECHState({ ...node, importExtras })
    assert.ok(r.err)
  }
})
