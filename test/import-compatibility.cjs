const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { webcrypto } = require('node:crypto')
const yaml = require('js-yaml')
const source = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
const UUID = '00000000-0000-4000-8000-000000000001'
const pin = 'AB'.repeat(32)
const baseVMess = { v:'2', ps:'官方字段测试', add:'vm.example.com', port:'443', id:UUID, aid:'0', scy:'auto', net:'ws', type:'none', host:'cdn.example.com', path:'/test', tls:'tls', sni:'tls.example.com', alpn:'h2,http/1.1', fp:'chrome', insecure:'0', vcn:'verify.example.com', pcs:pin }
const uriVMess = value => 'vmess://' + Buffer.from(JSON.stringify(value)).toString('base64')
const decodeVMess = link => JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8'))
const clone = value => JSON.parse(JSON.stringify(value))
function setup() {
  const store = { policies:JSON.stringify([{id:'all',name:'All',target:'all',presets:[],domains:[],keywords:[],processes:[],enabled:true}]), profiles:JSON.stringify([{id:'main',name:'Main',token:'m'.repeat(32),enabled:true,own:'all',ups:[],regions:'all',pols:'all',policies:'inherit'}]) }
  const ctx = vm.createContext({ addEventListener(){},crypto:webcrypto,TextEncoder,TextDecoder,btoa,atob,URL,URLSearchParams,Request,Response,Headers,AbortController,AbortSignal,structuredClone,setTimeout,clearTimeout,console,
    CONF:{get:async(k,t)=>store[k]===undefined?null:t==='json'?JSON.parse(store[k]):store[k],put:async(k,v)=>{store[k]=v},delete:async k=>{delete store[k]}},
    fetch:async()=>{throw new Error('No remote nodes in import regression tests')}
  })
  vm.runInContext(source+'\n;globalThis.T={shareToOwn,shareLink,apiRoute,makeCookie,genClash,genSB,genSR,ownCompatibility,installOwnEditor}',ctx)
  return {T:ctx.T,store}
}
async function call(T, pathname, body) {
  const request = new Request('https://import.example'+pathname,{method:body===undefined?'GET':'POST',headers:{Cookie:'sess='+await T.makeCookie(),'Content-Type':'application/json',Origin:'https://import.example'},body:body===undefined?undefined:JSON.stringify(body)})
  const response=await T.apiRoute(request,new URL(request.url),{waitUntil(){}})
  return {status:response.status,body:await response.json()}
}

test('official v2rayN VMess JSON insecure/vcn/pcs imports, saves, reopens and exports intact',async()=>{
  const {T}=setup()
  const result=T.shareToOwn(uriVMess(baseVMess))
  assert.ok(result?.node, result?.err)
  const node=result.node
  assert.equal(node.insecure,false)
  assert.equal(node.verifyName,baseVMess.vcn)
  assert.equal(node.certSha256,pin)
  const saved=await call(T,'/api/own',{own:{n:node}})
  assert.equal(saved.status,200,JSON.stringify(saved.body))
  const reopened=(await call(T,'/api/own')).body.own.n
  assert.equal(reopened.verifyName,node.verifyName)
  assert.equal(reopened.certSha256,node.certSha256)
  const link=T.shareLink({name:node.name,own:true,o:reopened})
  const back=decodeVMess(link)
  assert.equal(back.insecure,'0')
  assert.equal(back.vcn,node.verifyName)
  assert.equal(back.pcs,node.certSha256)
})

for(const [input,expected] of [['0',false],['1',true],[0,false],[1,true],[false,false],[true,true],['false',false],['true',true]]) {
  test('VMess insecure accepts documented and common JSON representation '+JSON.stringify(input),()=>{
    const {T}=setup()
    const r=T.shareToOwn(uriVMess({...baseVMess,insecure:input}))
    assert.ok(r?.node,r?.err)
    assert.equal(r.node.insecure,expected)
  })
}

test('optional future VMess JSON fields are retained with a warning rather than blocking import',async()=>{
  const {T}=setup()
  const extra={version:3,label:'metadata',nested:{enabled:true,values:['a','b']}}
  const r=T.shareToOwn(uriVMess({...baseVMess,futureClientOption:extra,group:'test-group'}))
  assert.ok(r?.node,r?.err)
  assert.match(r.node.warn,/futureClientOption/)
  assert.deepEqual(clone(r.node.importExtras.vmess.futureClientOption),extra)
  assert.equal((await call(T,'/api/own',{own:{n:r.node}})).status,200)
  const saved=(await call(T,'/api/own')).body.own.n
  const back=decodeVMess(T.shareLink({name:'Renamed',own:true,o:{...saved,name:'Renamed',s:'changed.example.com'}}))
  assert.deepEqual(back.futureClientOption,extra)
  assert.equal(back.add,'changed.example.com')
  assert.equal(back.ps,'Renamed')
})

const queryCases=[
  ['vless',`vless://${UUID}@v.example.com:443?encryption=none&security=tls&type=ws&path=%2Ftest&clientExtra=value#VL`],
  ['hysteria2','hy2://fake@hy.example.com?sni=hy.example.com&clientExtra=value#HY'],
  ['ss','ss://'+Buffer.from('aes-128-gcm:fake').toString('base64')+'@ss.example.com:8388/?group=test&clientExtra=value#SS'],
  ['anytls','anytls://fake@any.example.com/?sni=any.example.com&clientExtra=value#ANY'],
]
for(const [type,link] of queryCases) {
  test(type+' unknown query survives import/save/edit/URI export without rejecting valid base fields',async()=>{
    const {T}=setup()
    const r=T.shareToOwn(link)
    assert.ok(r?.node,r?.err)
    assert.equal(r.node.type,type)
    assert.match(r.node.warn,/clientExtra/)
    assert.ok(r.node.importExtras.query.some(([k,v])=>k==='clientExtra'&&v==='value'))
    assert.equal((await call(T,'/api/own',{own:{n:r.node}})).status,200)
    const saved=(await call(T,'/api/own')).body.own.n
    const raw=T.shareLink({name:saved.name,own:true,o:saved})
    assert.equal(new URL(raw).searchParams.get('clientExtra'),'value')
  })
}

test('AnyTLS official examples without port use 443, and HY2 default port remains supported',()=>{
  const {T}=setup()
  for(const uri of ['anytls://letmein@example.com/?sni=real.example.com','anytls://letmein@example.com/?sni=127.0.0.1&insecure=1','hy2://letmein@example.com/?insecure=0']){
    const r=T.shareToOwn(uri)
    assert.ok(r?.node,r?.err)
    assert.equal(Number(r.node.p),443)
  }
})

test('SIP002 ignores non-SS query names rather than treating them as active TLS or transport parameters',()=>{
  const {T}=setup()
  const r=T.shareToOwn('ss://'+Buffer.from('aes-128-gcm:fake').toString('base64')+'@ss.example.com:8388/?security=vendor-value&type=vendor-transport')
  assert.ok(r?.node,r?.err)
  assert.equal(r.node.type,'ss')
  assert.ok(r.node.importExtras.query.some(([key,value])=>key==='security'&&value==='vendor-value'))
})

test('supported transport aliases raw/websocket/splithttp are normalized rather than refused',()=>{
  const {T}=setup()
  for(const [alias,net] of [['raw','tcp'],['websocket','ws'],['splithttp','xhttp']]) {
    const r=T.shareToOwn(`vless://${UUID}@v.example.com:443?security=tls&type=${alias}&path=%2Ftest&mode=auto`)
    assert.ok(r?.node,r?.err)
    assert.equal(r.node.net,net)
  }
})

test('VMess named gRPC service and array ALPN are imported faithfully',()=>{
  const {T}=setup()
  const r=T.shareToOwn(uriVMess({...baseVMess,net:'grpc',serviceName:'Named-Service',path:'',alpn:['h2']}))
  assert.ok(r?.node,r?.err)
  assert.equal(r.node.serviceName,'Named-Service')
  assert.deepEqual(clone(r.node.alpn),['h2'])
})

test('repeated unknown query values survive URI round trip, but conflicting known duplicates are rejected',()=>{
  const {T}=setup()
  const r=T.shareToOwn('anytls://fake@any.example.com:443/?extra=a&extra=b')
  assert.ok(r?.node,r?.err)
  const back=new URL(T.shareLink({name:r.node.name,own:true,o:r.node}))
  assert.deepEqual(back.searchParams.getAll('extra'),['a','b'])
  const bad=T.shareToOwn(`vless://${UUID}@v.example.com:443?security=tls&security=none`)
  assert.ok(bad?.err,'ambiguous known parameters must not use different values in parsing and validation')
})

test('VMess URL-style extra parameters are preserved in exported JSON instead of disappearing',()=>{
  const {T}=setup()
  const r=T.shareToOwn(`vmess://${UUID}@vm.example.com:443?security=tls&type=ws&path=%2Ftest&clientExtra=value`)
  assert.ok(r?.node,r?.err)
  const back=decodeVMess(T.shareLink({name:r.node.name,own:true,o:r.node}))
  assert.equal(back.clientExtra,'value')
})

test('SS supported plugin with extra options is editable and retains unknown plugin parameters',async()=>{
  const {T}=setup()
  const r=T.shareToOwn('ss://'+Buffer.from('aes-128-gcm:fake').toString('base64')+'@ss.example.com:8388/?plugin='+encodeURIComponent('v2ray-plugin;mode=websocket;host=cdn.example.com;custom=value'))
  assert.ok(r?.node,r?.err)
  assert.match(r.node.warn,/custom/)
  assert.equal(r.node.importExtras.plugin.custom,'value')
  assert.equal((await call(T,'/api/own',{own:{n:r.node}})).status,200)
  const saved=(await call(T,'/api/own')).body.own.n
  const back=new URL(T.shareLink({name:saved.name,own:true,o:saved})).searchParams.get('plugin')
  assert.match(back,/custom=value/)
})

test('certificate verification parameters are applied where supported, never silently weakened elsewhere',()=>{
  const {T}=setup()
  const r=T.shareToOwn(uriVMess(baseVMess))
  assert.ok(r?.node,r?.err)
  const pol=[{id:'all',name:'All',target:'all',presets:[],domains:[],keywords:[],processes:[],enabled:true}]
  const cfg=yaml.load(T.genClash(false,[],pol,{}, {n:r.node},{}))
  assert.equal(cfg.proxies[0]['name-cert-verify'],baseVMess.vcn)
  assert.equal(cfg.proxies[0].fingerprint,pin)
  const warnings=T.ownCompatibility(r.node)
  assert.ok(warnings.some(w=>w.format==='singbox'&&w.field==='certSha256'))
  const sb=JSON.parse(T.genSB([],pol,{}, {n:r.node},{}))
  assert.ok(!sb.outbounds.some(x=>x.tag===r.node.name),'1.14 cannot express whole-certificate hash; do not remove pin and connect')
})

test('prototype pollution, invalid required data and oversized extras are still rejected',async()=>{
  const {T}=setup()
  const injected=JSON.parse(JSON.stringify(baseVMess).slice(0,-1)+',"__proto__":{"polluted":true}}')
  const r=T.shareToOwn(uriVMess(injected))
  assert.ok(!r?.node||r.err)
  assert.equal({}.polluted,undefined)
  const bad=T.shareToOwn(uriVMess({...baseVMess,port:'443oops'}))
  assert.ok(!bad?.node||bad.err)
  const long=T.shareToOwn(uriVMess({...baseVMess,big:'x'.repeat(70000)}))
  assert.ok(!long?.node||long.err)
})

test('editable extras cannot override or weaken main credentials, TLS or plugin settings',async()=>{
  const {T}=setup()
  const base={name:'Safe',type:'vmess',s:'vm.example.com',p:443,u:UUID,security:'tls',net:'tcp',cipher:'auto',insecure:false}
  for(const extras of [
    {query:[['insecure','1']]},{query:[['allowInsecure','1']]},{query:[['allow_insecure','1']]},
    {vmess:{insecure:'1'}},{vmess:{allowInsecure:true}},{vmess:{tls:'none'}},{vmess:{headers:{Host:'stale'}}},
    {plugin:{host:'stale.example.com'}},{plugin:{tls:''}},{plugin:{'obfs-host':'stale.example.com'}},
  ]) {
    const r=await call(T,'/api/own',{own:{n:{...base,importExtras:extras}}})
    assert.equal(r.status,400,JSON.stringify(extras))
  }
  const bypass={...base,importExtras:{query:[['insecure','1'],['allowInsecure','1']],vmess:{insecure:'1'}}}
  const output=decodeVMess(T.shareLink({name:base.name,own:true,o:bypass}))
  assert.equal(output.insecure,'0')
  assert.ok(!output.allowInsecure)
})

test('imported extras are exposed in the generated editor as escaped editable JSON',async()=>{
  const {T}=setup()
  const r=T.shareToOwn(uriVMess({...baseVMess,metadata:'</textarea><script>fake</script>'}))
  assert.ok(r?.node,r?.err)
  let captured
  const context=vm.createContext({window:{},OWN:{own:{n:r.node}},esc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),selectHTML:id=>'<div id="'+id+'"></div>',modal:async o=>{captured=o;return null}})
  vm.runInContext('('+T.installOwnEditor.toString()+')()',context)
  await context.window.editOwn('n')
  assert.match(captured.html,/id="oimportextras"/)
  assert.ok(captured.html.includes('&lt;script>'))
  assert.ok(!captured.html.includes('<script>fake</script>'))
})
