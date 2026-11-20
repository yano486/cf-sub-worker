const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const { test } = require('node:test')

test('demo build produces identical bytes from LF and Windows CRLF source checkouts', () => {
  const root = path.resolve(__dirname, '..')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfsub-demo-build-'))
  const files = ['scripts/build-demo.mjs', 'dev/fixtures.mjs', 'worker.js', 'test/fixture.yaml']
  try {
    const outputs = []
    for (const newline of ['\n', '\r\n']) {
      const checkout = path.join(temp, newline === '\n' ? 'lf' : 'crlf')
      for (const file of files) {
        const target = path.join(checkout, file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n')
        fs.writeFileSync(target, source.replace(/\n/g, newline))
      }
      fs.mkdirSync(path.join(checkout, 'docs'))
      execFileSync(process.execPath, [path.join(checkout, 'scripts/build-demo.mjs')], {
        env: { ...process.env, DEMO_OUT: path.join(checkout, 'docs/demo.html') }, stdio: 'pipe',
      })
      outputs.push(fs.readFileSync(path.join(checkout, 'docs/demo.html')))
    }
    assert.ok(outputs[1].equals(outputs[0]), 'generated demo must not depend on checkout line endings')
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temp).startsWith('cfsub-demo-build-'))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
