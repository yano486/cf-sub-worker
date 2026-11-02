const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const assert=require('node:assert/strict')
const {test}=require('node:test')
const yaml=require('js-yaml')
const source=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8')
const ctx=vm.createContext({addEventListener(){},TextEncoder,TextDecoder,URL,URLSearchParams,atob,btoa,fetch(){throw new Error('No actual node connections in tests')}})
vm.runInContext(source+';globalThis.T={parseOwnJSON,normalizeOwnNode,ownToKv,ownToSB,ownCompatibility,shareLink,genClash}',ctx)
const T=ctx.T,UUID='11111111-2222-3333-4444-555555555555',PK='A'.repeat(43)
const flow=value=>`    - { name: Test, type: vless, server: safe.example, port: 25565, uuid: ${UUID}, udp: true, flow: xtls-rprx-vision, tls: true, skip-cert-verify: false, client-fingerprint: firefox, servername: tls.example, reality-opts: { public-key: ${PK}, short-id: 0592b9f3${value===undefined?'':', support-x25519mlkem768: '+value} } }`
const parse=text=>JSON.parse(JSON.stringify(T.parseOwnJSON(text)))

test('Mihomo Reality capability imports true and false without losing authentication or short-id',()=>{
  for(const value of [true,false]){
    const result=parse(flow(value))
    assert.equal(result.ok,true,result.msg)
    const n=result.nodes[0]
    assert.equal(n.realityPQ,value)
    assert.equal(n.sid,'0592b9f3')
    assert.equal(n.pk,PK)
    assert.equal(n.fp,'firefox')
    assert.equal(n.flow,'xtls-rprx-vision')
    const kv=T.ownToKv(n),options=JSON.parse(kv['reality-opts'])
    assert.equal(options['support-x25519mlkem768'],value)
    const clash=yaml.load(T.genClash(false,[],[],{}, {n},{}))
    assert.equal(clash.proxies[0]['reality-opts']['support-x25519mlkem768'],value)
    const reopened=parse(JSON.stringify(n))
    assert.equal(reopened.ok,true,reopened.msg)
    assert.equal(reopened.nodes[0].realityPQ,value)
  }
})

test('missing capability remains missing, not a new implicit default for existing nodes',()=>{
  const result=parse(flow())
  assert.equal(result.ok,true,result.msg)
  assert.equal(result.nodes[0].realityPQ,undefined)
  const normalized=T.normalizeOwnNode(result.nodes[0])
  assert.equal(normalized.node.realityPQ,undefined)
  assert.equal(JSON.parse(T.ownToKv(normalized.node)['reality-opts'])['support-x25519mlkem768'],undefined)
})

test('invalid or misplaced capability fields fail at their actual source path',()=>{
  for(const value of ['"true"','1','null']){
    const result=parse(flow(value))
    assert.equal(result.ok,false)
    assert.ok(result.msg.includes('reality-opts.support-x25519mlkem768'))
  }
  const valid=parse(flow()).nodes[0]
  for(const n of [{...valid,realityPQ:'true'},{...valid,realityPQ:1},{...valid,realityPQ:true,security:'tls'},{...valid,realityPQ:true,type:'vmess',security:'tls'}])assert.ok(T.normalizeOwnNode(n).err)
})

test('v2rayN-style sharing retains standard Reality identity without inventing a PQ URI switch',()=>{
  const result=parse(flow(true));assert.equal(result.ok,true,result.msg)
  const n=result.nodes[0],link=new URL(T.shareLink({name:n.name,own:true,o:n}))
  for(const [key,value]of Object.entries({security:'reality',pbk:PK,sid:'0592b9f3',sni:'tls.example',fp:'firefox',flow:'xtls-rprx-vision'}))assert.equal(link.searchParams.get(key),value)
  assert.equal(link.searchParams.has('support-x25519mlkem768'),false)
  assert.equal(link.searchParams.has('mldsa65Verify'),false)
  const sb=T.ownToSB(n)
  assert.ok(sb)
  assert.equal(sb.tls.reality.public_key,PK)
  assert.equal(sb.tls.reality.short_id,'0592b9f3')
  assert.ok(T.ownCompatibility(n).some(w=>w.format==='share'&&w.field==='realityPQ'&&/协商/.test(w.reason)))
})
