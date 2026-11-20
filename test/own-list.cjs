const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const copy = value => JSON.parse(JSON.stringify(value))
const nodes = {
  a: { name: 'A', type: 'vless', s: 'safe.example', p: 443, u: '11111111-2222-3333-4444-555555555555', net: 'ws', path: '/', host: 'cdn.example', importExtras: { query: [['ech', 'ech.example']] } },
  b: { name: 'B', type: 'hysteria2', s: 'safe.example', p: 443, u: 'synthetic-test-password' },
  c: { name: 'C', type: 'anytls', s: 'safe.example', p: 443, u: 'synthetic-test-password' },
}
function setup({ initial = nodes, failRead = false, failWrite = false } = {}) {
  const store = { nodes: JSON.stringify(initial), 'auth:secret': JSON.stringify('s'.repeat(64)) }
  const writes = []
  const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, btoa, atob, crypto: webcrypto,
    fetch() { throw new Error('Own list tests must not request upstream services') },
    CONF: {
      get: async (key, type) => { if (key === 'nodes' && failRead) throw new Error('Synthetic read failure'); return store[key] === undefined ? null : type === 'json' ? JSON.parse(store[key]) : store[key] },
      put: async (key, value) => { if (failWrite) throw new Error('Synthetic write failure'); writes.push(key); store[key] = value },
    },
  })
  vm.runInContext(source + ';globalThis.T={handle,makeCookie,ownWarningGroups:typeof ownWarningGroups === "function" ? ownWarningGroups : null}', ctx)
  return { T: ctx.T, store, writes }
}
async function reorder(s, body, { anonymous = false, origin = 'https://panel.example' } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' }
  if (!anonymous) headers.Cookie = 'sess=' + await s.T.makeCookie('s'.repeat(64))
  return s.T.handle(new Request('https://panel.example/api/own', { method: 'POST', headers, body: JSON.stringify({ act: 'reorder', ...body }) }), { waitUntil() {} })
}
const order = ['c', 'a', 'b'], expectedOrder = ['a', 'b', 'c']

test('reordering writes nodes once and preserves every value and reference without normalization', async () => {
  const s = setup(), response = await reorder(s, { order, expectedOrder })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.ok, true)
  assert.deepEqual(result.order, order)
  assert.deepEqual(Object.keys(JSON.parse(s.store.nodes)), order)
  assert.deepEqual(JSON.parse(s.store.nodes), nodes, 'legacy fields and omitted defaults must stay untouched')
  assert.deepEqual(s.writes, ['nodes'])
})

test('unchanged order is acknowledged without a KV write', async () => {
  const s = setup(), response = await reorder(s, { order: expectedOrder, expectedOrder })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  assert.deepEqual(s.writes, [])
})

test('reordering uses current stored node values, not stale form data', async () => {
  const s = setup()
  const changed = { ...nodes, b: { ...nodes.b, u: 'changed-test-password' } }
  s.store.nodes = JSON.stringify(changed)
  const response = await reorder(s, { order, expectedOrder, own: nodes })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(s.store.nodes), changed)
})

for (const body of [
  { order: ['a', 'b'], expectedOrder }, { order: ['a', 'a', 'b'], expectedOrder },
  { order: ['a', 'b', 'unknown'], expectedOrder }, { order: ['a', 'b', '__proto__'], expectedOrder },
  { order: [0, 'b', 'c'], expectedOrder }, { order: {}, expectedOrder }, { order },
]) test('malformed or incomplete order never deletes or creates nodes: ' + JSON.stringify(body.order), async () => {
  const s = setup(), before = s.store.nodes, response = await reorder(s, body)
  assert.equal(response.ok, false)
  assert.equal(s.store.nodes, before)
  assert.deepEqual(s.writes, [])
})

test('stale list membership or order returns conflict without overwriting current data', async () => {
  for (const current of [{ c: nodes.c, b: nodes.b, a: nodes.a }, { ...nodes, added: { ...nodes.a, name: 'Added' } }]) {
    const s = setup({ initial: current }), before = s.store.nodes, response = await reorder(s, { order, expectedOrder })
    assert.equal(response.status, 409)
    assert.equal(s.store.nodes, before)
    assert.deepEqual(s.writes, [])
  }
})

test('read and write failures report unavailable and never replace nodes with defaults', async () => {
  for (const options of [{ failRead: true }, { failWrite: true }]) {
    const s = setup(options), before = s.store.nodes, response = await reorder(s, { order, expectedOrder })
    assert.equal(response.status, 503)
    assert.equal(s.store.nodes, before)
    assert.deepEqual(s.writes, [])
  }
})

test('numeric legacy keys cannot report a saved order that JSON objects cannot represent', async () => {
  const s = setup({ initial: { '1': nodes.a, '2': nodes.b } }), before = s.store.nodes
  const response = await reorder(s, { order: ['2', '1'], expectedOrder: ['1', '2'] })
  assert.equal(response.ok, false)
  assert.equal(s.store.nodes, before)
  assert.deepEqual(s.writes, [])
})

test('reordering requires an authenticated same-origin request', async () => {
  for (const [options, status] of [[{ anonymous: true }, 401], [{ origin: 'https://other.example' }, 403]]) {
    const s = setup(), response = await reorder(s, { order, expectedOrder }, options)
    assert.equal(response.status, status)
    assert.deepEqual(s.writes, [])
  }
})

test('warning groups merge names only when field, reason and exact client set agree', () => {
  const { T } = setup()
  assert.equal(typeof T.ownWarningGroups, 'function')
  const warnings = [
    { name: 'A', field: 'importExtras', reason: 'ECH warning', format: 'clash' },
    { name: 'A', field: 'importExtras', reason: 'ECH warning', format: 'singbox' },
    { name: 'B', field: 'importExtras', reason: 'ECH warning', format: 'singbox' },
    { name: 'B', field: 'importExtras', reason: 'ECH warning', format: 'clash' },
    { name: 'B', field: 'importExtras', reason: 'ECH warning', format: 'clash' },
    { name: 'C', field: 'importExtras', reason: 'ECH warning', format: 'clash' },
    { name: 'A', field: 'fp', reason: 'Other warning', format: 'shadowrocket' },
  ]
  const before = JSON.stringify(warnings)
  assert.deepEqual(copy(T.ownWarningGroups(warnings)), [
    { names: ['A', 'B'], field: 'importExtras', reason: 'ECH warning', formats: ['clash', 'singbox'] },
    { names: ['C'], field: 'importExtras', reason: 'ECH warning', formats: ['clash'] },
    { names: ['A'], field: 'fp', reason: 'Other warning', formats: ['shadowrocket'] },
  ])
  assert.equal(JSON.stringify(warnings), before)
})
