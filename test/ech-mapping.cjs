const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa })
vm.runInContext(source + ';globalThis.mapECH = typeof echForFormat === "function" ? echForFormat : undefined', ctx)
const mapECH = (...args) => {
  assert.equal(typeof ctx.mapECH, 'function', 'worker must provide the ECH format mapper')
  return JSON.parse(JSON.stringify(ctx.mapECH(...args)))
}

// Public config generated offline by mihomo generate ech-keypair ech.example.
const ECH = 'AEb+DQBCAAAgACAp3E/e9JUAXiwcl1s/1TZlTHOzX1EPd+0nzgwyR+VkRQAMAAEAAQABAAIAAQADAAtlY2guZXhhbXBsZQAA'
const PEM = [
  '-----BEGIN ECH CONFIGS-----',
  'AEb+DQBCAAAgACAp3E/e9JUAXiwcl1s/1TZlTHOzX1EPd+0nzgwyR+VkRQAMAAEA',
  'AQABAAIAAQADAAtlY2guZXhhbXBsZQAA',
  '-----END ECH CONFIGS-----',
]
const own = tlsSettings => ({ name: 'ECH', type: 'vless', s: 'node.example', p: 443,
  u: '11111111-2222-3333-4444-555555555555', security: 'tls', sni: 'tls.example',
  clientOptions: { xray: { tlsSettings } } })
const unsupported = result => {
  assert.equal(result.supported, false)
  assert.equal(typeof result.reason, 'string')
  assert.ok(result.reason.length > 0)
  assert.equal(result.clash, undefined)
  assert.equal(result.singbox, undefined)
}
const mutate = edit => {
  const bytes = Buffer.from(ECH, 'base64')
  edit(bytes)
  return bytes.toString('base64')
}

test('absent and inactive ECH do not restrict otherwise supported formats', () => {
  for (const format of ['clash', 'singbox', 'share', 'shadowrocket']) {
    for (const node of [undefined, null, {}, { clientOptions: {} }, { clientOptions: { xray: {} } }, own({}), own({ echConfigList: '', echForceQuery: '' })]) {
      assert.deepEqual(mapECH(node, format), { supported: true })
    }
  }
})

test('fixed Xray ECHConfigList maps byte-for-byte to Mihomo ech-opts', () => {
  for (const type of ['vless', 'vmess']) {
    const n = { ...own({ echConfigList: ECH }), type }
    assert.deepEqual(mapECH(n, 'clash'), { supported: true, clash: { 'ech-opts': { enable: true, config: ECH } } })
  }
})

test('fixed Xray ECHConfigList maps to sing-box PEM rather than rejected raw base64', () => {
  assert.deepEqual(mapECH(own({ echConfigList: ECH, echForceQuery: '' }), 'singbox'), {
    supported: true, singbox: { ech: { enabled: true, config: PEM } },
  })
  assert.equal(Buffer.from(PEM.slice(1, -1).join(''), 'base64').toString('base64'), ECH)
})

test('share and Shadowrocket formats do not silently discard active ECH', () => {
  for (const format of ['share', 'shadowrocket', 'unknown']) unsupported(mapECH(own({ echConfigList: ECH }), format))
})

test('resolver-backed ECH is never replaced by the generated configuration DNS resolver', () => {
  for (const resolver of ['https://dns.example/dns-query', 'udp://192.0.2.53', 'h2c://dns.example/dns-query', 'ech.example+https://dns.example/dns-query']) {
    for (const format of ['clash', 'singbox']) {
      const result = mapECH(own({ echConfigList: resolver }), format)
      unsupported(result)
      assert.ok(!result.reason.includes(resolver))
      assert.ok(!result.reason.includes('dns.example'))
    }
  }
})

test('meaningful or malformed echForceQuery is not guessed to have equivalent semantics', () => {
  for (const echForceQuery of ['full', 'half', 'none', ' ', 'sensitive-force-query', true, null, 1, {}]) {
    for (const echConfigList of [ECH, '', undefined]) {
      const result = mapECH(own({ echConfigList, echForceQuery }), 'clash')
      unsupported(result)
      assert.ok(!result.reason.includes('sensitive-force-query'))
    }
  }
})

test('malformed or oversized base64 is rejected without throwing or echoing its contents', () => {
  for (const echConfigList of [null, 1, {}, [], 'sensitive-invalid-config', 'A'.repeat(32772), ECH + '\n', ' ' + ECH,
    ECH.replace('+', '-'), 'AAAA', 'aGVsbG8=', 'AA==', 'AB==']) {
    const result = mapECH(own({ echConfigList }), 'singbox')
    unsupported(result)
    assert.ok(!result.reason.includes('sensitive-invalid-config'))
  }
})

test('base64 alone is insufficient: ECH list, record, vectors and extension framing must be valid', () => {
  const invalid = [
    mutate(b => b.writeUInt16BE(b.length, 0)),
    mutate(b => b.writeUInt16BE(0, 2)),
    mutate(b => b.writeUInt16BE(0xffff, 4)),
    mutate(b => b.writeUInt16BE(0, 9)),
    mutate(b => b.writeUInt16BE(0xffff, 9)),
    mutate(b => b.writeUInt16BE(0, 43)),
    mutate(b => b.writeUInt16BE(3, 43)),
    mutate(b => b[58] = 0),
    mutate(b => b[59] = 0),
    mutate(b => b.writeUInt16BE(1, 70)),
  ]
  for (const echConfigList of invalid) unsupported(mapECH(own({ echConfigList }), 'clash'))
  const truncated = Buffer.from(ECH, 'base64').subarray(0, -1)
  truncated.writeUInt16BE(truncated.length - 2, 0)
  unsupported(mapECH(own({ echConfigList: truncated.toString('base64') }), 'clash'))
})

test('multiple complete configs remain a single unchanged ECHConfigList', () => {
  const record = Buffer.from(ECH, 'base64').subarray(2)
  const list = Buffer.concat([Buffer.from([0, 140]), record, record]).toString('base64')
  assert.deepEqual(mapECH(own({ echConfigList: list }), 'clash'), {
    supported: true, clash: { 'ech-opts': { enable: true, config: list } },
  })
  const pem = mapECH(own({ echConfigList: list }), 'singbox').singbox.ech.config
  assert.equal(pem.slice(1, -1).join(''), list)
  assert.ok(pem.slice(1, -1).every(line => line.length <= 64))
})

test('unknown tlsSettings structures are unsupported rather than silently lost', () => {
  for (const tlsSettings of [null, [], 'invalid', { echConfigList: ECH, additionalField: 'sensitive-extra' }]) {
    const result = mapECH(own(tlsSettings), 'clash')
    unsupported(result)
    assert.ok(!result.reason.includes('sensitive-extra'))
  }
})

test('mapping is pure and leaves credentials, security, finalmask and source options untouched', () => {
  const n = own({ echConfigList: ECH, echForceQuery: '' })
  n.clientOptions.xray.finalmask = { tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '100-200', delay: '10-20' } }] }
  const before = JSON.stringify(n)
  Object.freeze(n.clientOptions.xray.tlsSettings)
  for (const format of ['clash', 'singbox', 'share']) {
    const output = mapECH(n, format)
    if (format !== 'share') assert.equal(output.supported, true)
    assert.equal(JSON.stringify(n), before)
    assert.ok(!JSON.stringify(output).includes(n.u))
    assert.ok(!JSON.stringify(output).includes('finalmask'))
  }
})
