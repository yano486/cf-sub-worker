const fs=require('node:fs')
const path=require('node:path')
const vm=require('node:vm')
const assert=require('node:assert/strict')
const {test}=require('node:test')
const {webcrypto}=require('node:crypto')
const source=fs.readFileSync(path.join(__dirname,'../worker.js'),'utf8')
const ECH='ech.example+https://dns.example/dns-query?key=a%2Bb&mode=full'
const UUID='11111111-2222-3333-4444-555555555555'
const base={name:'Synthetic',type:'vless',s:'safe.example',p:443,u:UUID,security:'tls',sni:'tls.example',net:'ws',path:'/test',host:'cdn.example',flow:'',encryption:'none',insecure:false}
const copy=v=>JSON.parse(JSON.stringify(v))
function setup(){
  const secret='s'.repeat(64),store={'auth:secret':JSON.stringify(secret),'auth:password':JSON.stringify('existing-fictional-hash'),profiles:JSON.stringify([{id:'main',name:'Main',token:'t'.repeat(32),enabled:true,own:'all',ups:[],regions:'all',pols:'all',policies:'inherit'}]),policies:JSON.stringify([{id:'all',name:'All',target:'all',enabled:true,presets:[],domains:[],keywords:[],processes:[]}])},writes=[]
  const c=vm.createContext({addEventListener(){},crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,Request,Response,Headers,atob,btoa,console,
    CONF:{get:async(k,t)=>store[k]===undefined?null:t==='json'?JSON.parse(store[k]):store[k],put:async(k,v)=>{writes.push(k);store[k]=v},delete:async k=>{delete store[k]}},fetch:()=>{throw new Error('No actual node or resolver requests allowed')}})
  vm.runInContext(source+';globalThis.T={shareToOwn,parseOwnJSON,shareLink,genShare,ownCompatibility,apiRoute,makeCookie}',c)
  return{T:c.T,store,writes,secret}
}
const uri=(T,n,basic=false)=>T.shareLink({name:n.name,own:true,o:n},basic)

test('JSON-imported echConfigList and URI-imported ech export the same decoded ECH value',()=>{
  const {T}=setup(),params=new URLSearchParams({encryption:'none',security:'tls',type:'ws',path:'/test',sni:'tls.example',host:'cdn.example',ech:ECH})
  const link='vless://'+UUID+'@safe.example:443?'+params+'#Synthetic'
  const fromURI=T.shareToOwn(link)
  assert.ok(fromURI.node,fromURI.err)
  const parsed=T.parseOwnJSON(JSON.stringify({protocol:'vless',tag:'Synthetic',settings:{address:'safe.example',port:443,id:UUID,encryption:'none'},streamSettings:{network:'ws',security:'tls',tlsSettings:{serverName:'tls.example',echConfigList:ECH},wsSettings:{path:'/test',host:'cdn.example'}}}))
  assert.equal(parsed.ok,true,parsed.msg)
  const jsonURL=new URL(uri(T,parsed.nodes[0]))
  const uriURL=new URL(uri(T,fromURI.node))
  assert.equal(jsonURL.searchParams.get('ech'),ECH)
  assert.equal(uriURL.searchParams.get('ech'),ECH)
  assert.equal(jsonURL.searchParams.getAll('ech').length,1)
  assert.equal(jsonURL.searchParams.get('path'),'/test')
  assert.equal(jsonURL.searchParams.get('security'),'tls')
  assert.ok(!T.ownCompatibility(parsed.nodes[0]).some(w=>w.format==='share'&&w.field==='clientOptions'))
})

test('explicit basic links preserve URI-representable ECH while still excluding finalmask and unrepresented query policy',()=>{
  const {T}=setup(),n={...base,clientOptions:{xray:{tlsSettings:{echConfigList:ECH,echForceQuery:'full'},finalmask:{tcp:[{type:'fragment',settings:{packets:'tlshello',length:'100-200',delay:'10-20'}}]}}}}
  const before=JSON.stringify(n)
  assert.equal(uri(T,n),'')
  const basic=new URL(uri(T,n,true))
  assert.equal(basic.searchParams.get('ech'),ECH)
  assert.equal(basic.searchParams.has('finalmask'),false)
  assert.equal(basic.searchParams.has('echForceQuery'),false)
  const approved={...copy(n),compatibilityMode:'basic'}
  const share=atob(T.genShare([], {n:approved},{})).split('\n')[0]
  assert.equal(new URL(share).searchParams.get('ech'),ECH)
  const notices=T.ownCompatibility(approved).filter(w=>w.format==='share'&&w.field==='clientOptions')
  assert.ok(notices.some(w=>w.reason.includes('finalmask')))
  assert.ok(notices.some(w=>w.reason.includes('echForceQuery')))
  assert.equal(JSON.stringify(n),before)
  const strictBatch=atob(T.genShare([], {first:base,second:{...n,name:'Blocked-second'},third:{...n,name:'Blocked-third'}},{}))
  assert.ok(!strictBatch.includes('Blocked-second'))
  assert.ok(!strictBatch.includes('Blocked-third'))
  assert.equal(strictBatch.split('\n').length,1)
  assert.equal(T.shareLink({name:n.name,own:true,o:n},1),'')
})

test('typed ECH is encoded once, deduplicates equal case-insensitive parameters, and rejects conflicts',()=>{
  const {T}=setup(),n={...base,clientOptions:{xray:{tlsSettings:{echConfigList:ECH}}},importExtras:{query:[['ech',ECH],['ECH',ECH],['clientExtra','keep-me']]}}
  const link=new URL(uri(T,n))
  assert.equal(link.searchParams.get('ech'),ECH)
  assert.equal(link.searchParams.getAll('ech').length,1)
  assert.equal(link.searchParams.get('clientExtra'),'keep-me')
  assert.equal(decodeURIComponent(link.hash.slice(1)),n.name)
  const again=T.shareToOwn(link.href)
  assert.ok(again.node,again.err)
  assert.equal(new URL(uri(T,again.node)).searchParams.get('ech'),ECH)
  assert.throws(()=>uri(T,{...n,importExtras:{query:[['ech','different-configuration']]}}),/ECH.*冲突/)
})

test('ECH raw encoding matches v2rayN percent-decoding instead of form-style plus decoding',()=>{
  const {T}=setup()
  for(const ech of ['https://dns.example/dns query','ech.example+https://dns.example/query?value=literal+plus%20and space','literal / = % & ? # 中']){
    const n={...base,clientOptions:{xray:{tlsSettings:{echConfigList:ech}}}}
    const url=new URL(uri(T,n))
    const pair=url.search.slice(1).split('&').find(s=>s.startsWith('ech='))
    assert.ok(pair)
    assert.equal(decodeURIComponent(pair.slice(4)),ech)
    assert.ok(!pair.includes('+'),'literal plus must be encoded, and spaces must use %20')
    assert.equal(url.searchParams.get('ech'),ech)
  }
})

test('authenticated node view exposes an ECH-preserving basic link without changing stored proxy or jp records',async()=>{
  const {T,store,writes,secret}=setup()
  const proxy={...base,name:'proxy',clientOptions:{xray:{tlsSettings:{echConfigList:ECH,echForceQuery:'full'},finalmask:{tcp:[{type:'fragment',settings:{packets:'tlshello'}}]}}}}
  const jp={...base,name:'jp',importExtras:{query:[['ech',ECH]]}}
  store.nodes=JSON.stringify({proxy,jp});const before=store.nodes
  const request=new Request('https://panel.example/api/own',{headers:{Cookie:'sess='+await T.makeCookie(secret)}})
  const response=await T.apiRoute(request,new URL(request.url),{waitUntil(){}})
  assert.equal(response.status,200)
  const result=await response.json()
  assert.equal(new URL(result.basicLinks.proxy).searchParams.get('ech'),ECH)
  assert.equal(new URL(result.links.jp).searchParams.get('ech'),ECH)
  assert.equal(store.nodes,before)
  assert.deepEqual(writes,[])
})
