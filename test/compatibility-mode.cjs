const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const {test} = require('node:test')
const yaml = require('js-yaml')
const source = fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8')
const ctx = vm.createContext({addEventListener(){},TextEncoder,TextDecoder,URL,URLSearchParams,atob,btoa})
vm.runInContext(source+';globalThis.T={normalizeOwnNode,parseOwnJSON,genClash,genSB,genSR,genShare,ownToSB,ownCompatibility,shareLink}',ctx)
const T=ctx.T, copy=x=>JSON.parse(JSON.stringify(x))
const node={name:'Compat',type:'vless',s:'safe.example',p:443,u:'11111111-2222-3333-4444-555555555555',security:'tls',net:'ws',path:'/ws',host:'cdn.example',encryption:'none',flow:'',insecure:false,
  clientOptions:{xray:{tlsSettings:{echConfigList:'ech.example+https://dns.example/dns-query',echForceQuery:'full'},finalmask:{tcp:[{type:'fragment',settings:{packets:'tlshello',length:'100-200',delay:'10-20'}}]}}}}
const policy=[{id:'all',name:'Policy',target:'all',enabled:true,strict:false,presets:[],domains:[],keywords:[],processes:[]}]

test('strict defaults still block incompatible output and do not rewrite stored options',()=>{
  const before=JSON.stringify(node)
  assert.equal(T.ownToSB(node),null)
  assert.equal(T.shareLink({name:node.name,own:true,o:node}),'')
  assert.ok(!(yaml.load(T.genClash(false,[],policy,{}, {n:node},{})).proxies||[]).some(n=>n.name===node.name))
  assert.equal(JSON.stringify(node),before)
})

test('only an explicit basic mode enables otherwise incompatible subscription nodes',()=>{
  const n={...copy(node),compatibilityMode:'basic'},before=JSON.stringify(n)
  const normalized=T.normalizeOwnNode(n)
  assert.equal(normalized.err,undefined)
  assert.equal(normalized.node.compatibilityMode,'basic')
  assert.deepEqual(copy(normalized.node.clientOptions),node.clientOptions)
  const clash=yaml.load(T.genClash(false,[],policy,{}, {n},{}))
  const proxy=clash.proxies.find(p=>p.name===node.name)
  assert.ok(proxy)
  assert.equal(proxy.tls,true)
  assert.equal(proxy['skip-cert-verify'],false)
  assert.ok(clash['proxy-groups'].some(g=>(g.proxies||[]).includes(node.name)))
  const sb=T.ownToSB(n)
  assert.ok(sb)
  assert.equal(sb.uuid,node.u)
  assert.equal(sb.tls.insecure,false)
  assert.ok(T.genSR(false,[],policy,{}, {n},{}).includes(node.name))
  const share=atob(T.genShare([], {n},{}))
  assert.ok(share.startsWith('vless://'))
  assert.ok(!share.includes('echForceQuery'))
  assert.equal(JSON.stringify(n),before)
  const warnings=copy(T.ownCompatibility(n)).filter(w=>w.field==='clientOptions')
  assert.equal(warnings.length,4)
  assert.ok(warnings.every(w=>/基础兼容/.test(w.reason)&&/ECH/.test(w.reason)&&/finalmask/.test(w.reason)))
})

test('basic mode never removes certificate checks or unrelated protocol compatibility limits',()=>{
  const n={...copy(node),compatibilityMode:'basic',certSha256:'AB'.repeat(32)}
  assert.equal(T.ownToSB(n),null)
  const enc={...copy(node),compatibilityMode:'basic',encryption:'mlkem768x25519plus.native.0rtt.'+'A'.repeat(43)}
  assert.equal(T.ownToSB(enc),null)
  assert.ok(T.normalizeOwnNode({...node,compatibilityMode:'unknown'}).err)
  assert.ok(T.normalizeOwnNode({...node,compatibilityMode:true}).err)
})

test('native JSON round trips explicit mode but external formats cannot opt in by accident',()=>{
  const n={...copy(node),compatibilityMode:'basic'}
  const parsed=T.parseOwnJSON(JSON.stringify(n))
  assert.equal(parsed.ok,true,parsed.msg)
  assert.equal(parsed.nodes[0].compatibilityMode,'basic')
  const external={name:'External',type:'vless',server:'safe.example',port:443,uuid:node.u,tls:true,compatibilityMode:'basic'}
  assert.equal(T.parseOwnJSON(JSON.stringify(external)).ok,false)
})

test('basic mode can be disabled without losing original client-specific parameters',()=>{
  const basic=T.normalizeOwnNode({...node,compatibilityMode:'basic'}).node
  const strict=T.normalizeOwnNode({...basic,compatibilityMode:'strict'})
  assert.equal(strict.err,undefined)
  assert.equal(T.ownToSB(strict.node),null)
  assert.deepEqual(copy(strict.node.clientOptions),node.clientOptions)
})

test('fixed ECH is emitted accurately without basic mode; other source-only settings still require consent',()=>{
  const config='AEb+DQBCAAAgACAp3E/e9JUAXiwcl1s/1TZlTHOzX1EPd+0nzgwyR+VkRQAMAAEAAQABAAIAAQADAAtlY2guZXhhbXBsZQAA'
  const n={...copy(node),clientOptions:{xray:{tlsSettings:{echConfigList:config}}}}
  const clash=yaml.load(T.genClash(false,[],policy,{}, {n},{}))
  assert.deepEqual(clash.proxies.find(p=>p.name===n.name)['ech-opts'],{enable:true,config})
  const sb=T.ownToSB(n)
  assert.ok(sb)
  assert.equal(sb.tls.ech.enabled,true)
  assert.equal(sb.tls.ech.config.slice(1,-1).join(''),config)
  assert.equal(sb.tls.ech.config[0],'-----BEGIN ECH CONFIGS-----')
  assert.equal(new URL(T.shareLink({name:n.name,own:true,o:n})).searchParams.get('ech'),config)
  const mixed={...copy(n),clientOptions:{xray:{...n.clientOptions.xray,finalmask:node.clientOptions.xray.finalmask}}}
  assert.equal(T.ownToSB(mixed),null)
  const converted=T.ownToSB({...mixed,compatibilityMode:'basic'})
  assert.equal(converted.tls.ech.config.slice(1,-1).join(''),config)
  const warnings=T.ownCompatibility({...mixed,compatibilityMode:'basic'}).filter(w=>w.field==='clientOptions')
  const forSB=warnings.find(w=>w.format==='singbox')
  assert.ok(forSB.reason.includes('finalmask'))
  assert.ok(!forSB.reason.includes('ECH'))
})
