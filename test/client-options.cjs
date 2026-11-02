const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const yaml = require('js-yaml')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const ctx = vm.createContext({ addEventListener() {}, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa })
vm.runInContext(source + ';globalThis.T={normalizeOwnNode,ownToSB,ownToSR,ownCompatibility,genClash,shareLink}', ctx)
const T = ctx.T
const copy = x => JSON.parse(JSON.stringify(x))
const node = { name:'Options', type:'anytls', s:'node.example', p:443, u:'fictional-password', security:'tls', insecure:true }
const fragment = { singbox:{ tls:{ fragment:true, record_fragment:true, fragment_fallback_delay:'500ms' } } }
const xray = { xray:{ tlsSettings:{ echConfigList:'ech.example+https://dns.example/dns-query', echForceQuery:'full' }, finalmask:{ tcp:[{ type:'fragment', settings:{ packets:'tlshello', length:'100-200', delay:'10-20' } }] } } }

test('normalization preserves bounded client-specific options without rewriting core security', () => {
  const result = T.normalizeOwnNode({ ...node, clientOptions:fragment })
  assert.equal(result.err, undefined)
  assert.deepEqual(copy(result.node.clientOptions), fragment)
  assert.equal(result.node.insecure, true)
  const vless = T.normalizeOwnNode({ ...node, type:'vless', u:'11111111-2222-3333-4444-555555555555', net:'ws', path:'/', flow:'', clientOptions:xray })
  assert.equal(vless.err, undefined)
  assert.deepEqual(copy(vless.node.clientOptions), xray)
})

test('inactive client defaults do not create special-parameter blocks', () => {
  for (const clientOptions of [
    {singbox:{tls:{fragment:false,record_fragment:false,fragment_fallback_delay:'500ms'}}},
    {xray:{tlsSettings:{echConfigList:'',echForceQuery:''},finalmask:{tcp:[],udp:[]}}},
  ]) {
    const type=clientOptions.xray?'vless':'anytls'
    const n={...node,type,net:'tcp',flow:'',clientOptions}
    const result=T.normalizeOwnNode(n)
    assert.equal(result.err,undefined)
    assert.equal(result.node.clientOptions,undefined)
    assert.ok(T.shareLink({name:n.name,own:true,o:n}))
  }
})

test('client options cannot override credentials, enable another protocol, or contain unsafe structures', () => {
  const cases = [
    { singbox:{ tls:{ insecure:true } } },
    { singbox:{ tls:{ fragment:'true' } } },
    { xray:{ tlsSettings:{ allowInsecure:true } } },
    { other:{ password:'fictional' } },
    { singbox:{ tls:{ fragment_fallback_delay:'not-a-duration' } } },
    { singbox:{ tls:{ fragment_fallback_delay:'9'.repeat(100) + 'h' } } },
    JSON.parse('{"xray":{"finalmask":{"tcp":[{"__proto__":{"polluted":true}}]}}}'),
    { xray:{ tlsSettings:{ echConfigList:'x'.repeat(33000) } } },
  ]
  for (const clientOptions of cases) assert.ok(T.normalizeOwnNode({ ...node, clientOptions }).err)
  assert.ok(T.normalizeOwnNode({ ...node, type:'ss', cipher:'aes-128-gcm', security:'none', clientOptions:fragment }).err)
  assert.equal({}.polluted, undefined)
})

test('sing-box output retains supported TLS options rather than silently removing them', () => {
  const result = T.ownToSB({ ...node, clientOptions:fragment })
  assert.equal(result.tls.insecure, true)
  assert.equal(result.tls.fragment, true)
  assert.equal(result.tls.record_fragment, true)
  assert.equal(result.tls.fragment_fallback_delay, '500ms')
})

test('incompatible output formats omit the entire advanced node and all its group references', () => {
  const advanced = { ...node, clientOptions:fragment }
  assert.equal(T.shareLink({ name:node.name, own:true, o:advanced }), '')
  assert.equal(T.ownToSR(advanced), null)
  const config = yaml.load(T.genClash(false, [], [], {}, { option:advanced }, {}))
  assert.ok(!(config.proxies || []).some(n => n.name === node.name))
  for (const group of config['proxy-groups']) assert.ok(!(group.proxies || []).includes(node.name))
  assert.ok(T.ownCompatibility(advanced).some(w => w.format === 'clash' && w.field === 'clientOptions'))
  const xrayNode = { ...node, type:'vless', net:'ws', u:'11111111-2222-3333-4444-555555555555', clientOptions:xray }
  assert.equal(T.ownToSB(xrayNode), null)
  assert.equal(T.shareLink({ name:node.name, own:true, o:xrayNode }), '')
})

test('saving advanced nodes preserves their options and leaves unrelated legacy records untouched', async () => {
  const legacy = { name:'Legacy', type:'hysteria2', s:'legacy.example', p:443, u:'fictional-legacy' }
  const profiles=[{id:'main',name:'Main',token:'t'.repeat(32),enabled:true,own:'all',ups:[],regions:'all',pols:'all',policies:'inherit',mode:'whitelist',note:''}]
  const policies=[{id:'all',name:'All',target:'all',enabled:true,strict:false,presets:[],domains:[],keywords:[],processes:[]}]
  const secret='s'.repeat(64), store = { nodes:JSON.stringify({legacy}), profiles:JSON.stringify(profiles), policies:JSON.stringify(policies), 'auth:secret':JSON.stringify(secret), 'auth:password':JSON.stringify('fictional-existing-hash') }, writes=[]
  const c=vm.createContext({addEventListener(){},TextEncoder,TextDecoder,URL,URLSearchParams,Request,Response,Headers,atob,btoa,crypto:require('node:crypto').webcrypto,
    CONF:{get:async(k,type)=>store[k]===undefined?null:type==='json'?JSON.parse(store[k]):store[k],put:async(k,v)=>{writes.push(k);store[k]=v},delete:async k=>{delete store[k]}},
    fetch:()=>{throw new Error('No network during saving tests')}})
  vm.runInContext(source+';globalThis.api=apiRoute;globalThis.cookie=makeCookie',c)
  const req=new Request('https://panel.example/api/own',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://panel.example',Cookie:'sess='+await c.cookie(secret)},body:JSON.stringify({own:{legacy,newNode:{...node,clientOptions:fragment}}})})
  const response=await c.api(req,new URL(req.url),{waitUntil(){}})
  const result=await response.json()
  assert.equal(response.status,200,JSON.stringify(result))
  assert.deepEqual(result.own.newNode.clientOptions,fragment)
  assert.deepEqual(JSON.parse(store.nodes).legacy,legacy)
  assert.deepEqual(writes,['nodes'])
  const viewReq=new Request('https://panel.example/api/own',{headers:{Cookie:'sess='+await c.cookie(secret)}})
  const view=await (await c.api(viewReq,new URL(viewReq.url),{waitUntil(){}})).json()
  assert.equal(view.links.newNode,'')
  assert.ok(view.basicLinks.newNode.startsWith('anytls://'))
  assert.deepEqual(view.own.newNode.clientOptions,fragment)
  assert.deepEqual(JSON.parse(store.nodes).newNode.clientOptions,fragment)
  assert.deepEqual(writes,['nodes'])
})
