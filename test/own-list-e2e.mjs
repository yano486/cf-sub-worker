import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { launch, sleep } from '../scripts/cdp.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfsub-own-list-e2e-'))
const out = path.join(temp, 'demo.html')
execFileSync(process.execPath, [path.join(root, 'scripts/build-demo.mjs')], { env: { ...process.env, DEMO_OUT: out } })
const b = await launch()
let pass = 0, fail = 0
function check(result, name) { console.log((result ? 'PASS ' : 'FAIL ') + name); result ? pass++ : fail++ }
const until = `window.until=async f=>{for(let i=0;i<80;i++){if(await f())return true;await new Promise(r=>setTimeout(r,40))}return false};document.head.insertAdjacentHTML('beforeend','<style>*{animation:none!important;transition:none!important}</style>');document.getElementById('demobar')?.remove()`
const point = async (index, target = '.nm') => b.run(`document.querySelector('.uplist.own').scrollIntoView({block:'center'});const row=document.querySelectorAll('.uplist.own .up')[${index}];const r=(${JSON.stringify(target)}?row.querySelector(${JSON.stringify(target)}):row).getBoundingClientRect();return {x:r.x+Math.min(30,r.width/2),y:r.y+r.height/2}`)
const gesture = async (type, p, mobile) => mobile
  ? b.send('Input.dispatchTouchEvent', { type: { down:'touchStart', move:'touchMove', up:'touchEnd', cancel:'touchCancel' }[type], touchPoints: ['up','cancel'].includes(type) ? [] : [{ ...p, id:1 }] })
  : b.send('Input.dispatchMouseEvent', { type: { down:'mousePressed', move:'mouseMoved', up:'mouseReleased' }[type], ...p, button: type === 'move' ? 'none' : 'left', buttons: type === 'up' ? 0 : 1, clickCount: type === 'move' ? 0 : 1 })
try {
  await b.viewport(1100, 900)
  await b.open(pathToFileURL(out).href + '#node')
  await b.run(until)
  const labels = await b.run(`const before=OWN;try{
    OWN={ok:true,own:{a:{name:'A',type:'tuic',s:'safe.example',p:443},b:{name:'B',type:'anytls',s:'safe.example',p:443}},compatibility:{}}
    const div=document.createElement('div');div.innerHTML=ownCardInner();return [...div.querySelectorAll('.up .tgt')].map(x=>x.textContent)
  }finally{OWN=before}`)
  check(labels[0] === 'TUIC v5' && labels[1] === 'AnyTLS', 'TUIC badge uses the same display naming convention as the editor')
  const grouped = await b.run(`const before=OWN;try{
    const reason='导入扩展字段已保留，但当前完整配置尚未应用：ech', w=format=>({field:'importExtras',reason,format})
    OWN={ok:true,own:{a:{name:'A<img src=x>',s:'safe.example',p:443},b:{name:'B',s:'safe.example',p:443},c:{name:'C',s:'safe.example',p:443}},compatibility:{a:['clash','singbox','shadowrocket'].map(w),b:['shadowrocket','clash','singbox'].map(w),c:[w('clash')]}}
    const div=document.createElement('div');div.innerHTML=ownCardInner();const rows=[...div.querySelectorAll('.compat-warning')]
    return {count:rows.length,first:rows[0]?.textContent,second:rows[1]?.textContent,safe:!div.querySelector('img'),summary:div.querySelector('summary')?.textContent}
  }finally{OWN=before}`)
  check(grouped.count === 2 && grouped.first === 'A<img src=x>、B：Clash / sing-box / Shadowrocket：导入扩展字段已保留，但当前完整配置尚未应用：ech', 'identical warnings merge node names and preserve the exact client set')
  check(grouped.second?.startsWith('C：Clash：') && grouped.safe && grouped.summary?.includes('2'), 'different client sets remain separate and names are escaped')

  for (const mobile of [false, true]) {
    const name = mobile ? 'mobile' : 'desktop'
    await b.viewport(mobile ? 390 : 1100, mobile ? 844 : 900, { mobile, dark:mobile })
    await b.open(pathToFileURL(out).href + '#node')
    await b.run(until)
    await b.send('Emulation.setTouchEmulationEnabled', { enabled:mobile })
    await b.run(`window.initialOrder=Object.keys(OWN.own);window.initialValues=JSON.stringify(OWN.own);window.realFetch=window.fetch;window.sortPosts=[];
      window.fetch=(u,o)=>{if(u==='/api/own'&&o?.method==='POST'){const body=JSON.parse(o.body);if(body.act==='reorder')sortPosts.push(body)}return realFetch(u,o)}`)
    for (const bottom of [false,true]) {
      const p = await b.run(`document.querySelectorAll('.toast').forEach(el=>el.remove());const spacer=document.createElement('div');spacer.id='edge-spacer';spacer.style.height='600px';const card=document.getElementById('owncard');card.before(spacer);
        const node=document.querySelectorAll('.uplist.own .up')[${bottom ? 0 : 2}].querySelector('.nm');let r=node.getBoundingClientRect();scrollBy(0,r.y+r.height/2-(${bottom ? 'innerHeight-25' : '25'}));
        r=node.getBoundingClientRect();window.edgeOrder=[...document.querySelectorAll('.uplist.own .up')].map(x=>x.dataset.key);window.edgeY=scrollY;window.edgePoint={x:r.x+20,y:r.y+r.height/2};window.edgeHit=document.elementFromPoint(edgePoint.x,edgePoint.y)?.closest('.up.own')?.dataset.key;return edgePoint`)
      await gesture('down',p,mobile);await sleep(1050)
      const untouched = await b.run(`return !!document.querySelector('.uplist.own .tdrag')&&scrollY===edgeY&&sortPosts.length===0&&[...document.querySelectorAll('.uplist.own .up')].map(x=>x.dataset.key).join(',')===edgeOrder.join(',')`)
      if (!untouched) console.log('EDGE_DIAGNOSTIC',name,bottom,await b.run(`return {active:!!document.querySelector('.uplist.own .tdrag'),beforeY:edgeY,afterY:scrollY,point:edgePoint,hit:edgeHit,order:[...document.querySelectorAll('.uplist.own .up')].map(x=>x.dataset.key),before:edgeOrder,posts:sortPosts.length}`))
      await gesture('up',p,mobile);await sleep(80)
      check(untouched && await b.run(`return sortPosts.length===0`), name + (bottom?' bottom':' top') + ' edge stationary hold neither scrolls nor saves')
      await b.run(`window.fetch=realFetch;const current=Object.keys((await(await realFetch('/api/own')).json()).own);await realFetch('/api/own',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({act:'reorder',order:initialOrder,expectedOrder:current})});OWN=null;await dash(true);sortPosts=[];
        window.fetch=(u,o)=>{if(u==='/api/own'&&o?.method==='POST'){const body=JSON.parse(o.body);if(body.act==='reorder')sortPosts.push(body)}return realFetch(u,o)}`)
    }
    let start = await point(0), end = await point(2, '')
    await b.run(`window.gestureScrollY=scrollY`)
    await gesture('down', start, mobile)
    await gesture('move', { x:start.x, y:start.y-22 }, mobile)
    await sleep(560)
    check(await b.run(`return !document.querySelector('.uplist.own .tdrag')&&sortPosts.length===0`), name + ' movement before the long press cancels dragging without a write')
    if (mobile) check(await b.run(`return scrollY!==gestureScrollY`), 'mobile ordinary swiping actually scrolls the page')
    await gesture('up', start, mobile)
    start = await point(0)
    await gesture('down', start, mobile)
    await sleep(580)
    check(await b.run(`return !!document.querySelector('.uplist.own .tdrag')&&sortPosts.length===0`), name + ' half-second hold activates dragging without writing')
    await gesture('up', start, mobile)
    await sleep(100)
    check(await b.run(`return sortPosts.length===0&&!document.querySelector('.uplist.own .tdrag')`), name + ' unchanged drop does not write')
    start = await point(0); end = await point(2, '')
    await gesture('down', start, mobile)
    await sleep(580)
    await gesture('move', { ...end, y:end.y+12 }, mobile)
    check(await b.run(`return sortPosts.length===0`), name + ' moving rows never writes before release')
    await gesture('up', end, mobile)
    await b.run(`await until(()=>sortPosts.length===1&&!document.querySelector('.own-order-busy'));`)
    const saved = await b.run(`const r=await(await realFetch('/api/own')).json(),order=Object.keys(r.own);return {
      once:sortPosts.length===1,order:order.join(',')===[initialOrder[1],initialOrder[2],initialOrder[0]].join(','),
      values:initialOrder.every(k=>JSON.stringify(r.own[k])===JSON.stringify(JSON.parse(initialValues)[k])),
      payload:Object.keys(sortPosts[0]||{}).sort().join(',')==='act,expectedOrder,order'};`)
    check(saved.once && saved.order && saved.values && saved.payload, name + ' one ID-only request persists the order without modifying node values')
    const expected = await b.run(`return Object.keys((await(await realFetch('/api/own')).json()).own)`)
    await b.open(pathToFileURL(out).href + '#node')
    await b.run(until)
    check(await b.run(`return [...document.querySelectorAll('.uplist.own .up')].map(x=>x.dataset.key).join(',')===${JSON.stringify(expected.join(','))}`), name + ' order survives an actual page reload')
    await b.run(`window.realFetch=window.fetch;window.sortPosts=[];window.fetch=(u,o)=>{if(u==='/api/own'&&o?.method==='POST')sortPosts.push(JSON.parse(o.body));return realFetch(u,o)}`)
    start = await point(0); end = await point(2, '')
    await gesture('down', start, mobile); await sleep(580); await gesture('move', end, mobile)
    if (mobile) await gesture('cancel', end, true)
    else { await b.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 }); await gesture('up', end, false) }
    check(await b.run(`return sortPosts.length===0&&!document.querySelector('.uplist.own .tdrag')&&[...document.querySelectorAll('.uplist.own .up')].map(x=>x.dataset.key).join(',')===${JSON.stringify(expected.join(','))}`), name + ' cancelling restores the original order without saving')
    const buttons = await b.run(`const button=document.querySelector('.uplist.own [aria-label="编辑"]');button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:9,pointerType:'mouse',button:0,buttons:1}));await new Promise(r=>setTimeout(r,580));const active=!!document.querySelector('.uplist.own .tdrag');document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:9,pointerType:'mouse'}));return !active&&sortPosts.length===0`)
    check(buttons, name + ' operation buttons are excluded from drag activation')
    await b.run(`window.fetch=(u,o)=>u==='/api/own'&&o?.method==='POST'?Promise.resolve(new Response(JSON.stringify({ok:false,msg:'Synthetic sort failure'}),{status:503})):realFetch(u,o)`)
    start = await point(0); end = await point(2, '')
    await gesture('down', start, mobile); await sleep(580); await gesture('move', { ...end,y:end.y+12 }, mobile); await gesture('up', end, mobile)
    await b.run(`await until(()=>[...document.querySelectorAll('.toast')].some(x=>x.textContent.includes('Synthetic sort failure')))`)
    check(await b.run(`return [...document.querySelectorAll('.uplist.own .up')].map(x=>x.dataset.key).join(',')===${JSON.stringify(expected.join(','))}&&!document.querySelector('.own-order-busy')`), name + ' failed save rolls back instead of showing a false success')
    await b.run(`window.savedDisplayOwn=OWN;const reason='导入扩展字段已保留，但当前完整配置尚未应用：ech';const n={s:'safe.example',p:443};const w=['clash','singbox','shadowrocket'].map(format=>({format,field:'importExtras',reason}));
        OWN={ok:true,own:{a:{...n,type:'tuic',name:'A'},b:{...n,type:'vless',net:'ws',name:'B'},c:{...n,type:'anytls',name:'C'}},compatibility:{a:w,b:w,c:w}};
        document.getElementById('owncard').innerHTML=ownCardInner();bindOwnSort();document.querySelector('#owncard details').open=true;document.getElementById('owncard').scrollIntoView({block:'center'});document.querySelectorAll('.toast').forEach(el=>el.remove())`)
    check(await b.run(`const card=document.getElementById('owncard');return card.scrollWidth<=card.clientWidth+1&&card.querySelector('.compat-warning').textContent.startsWith('A、B、C：')`), name + ' merged warnings wrap without horizontal overflow')
    if (process.env.E2E_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.E2E_SCREENSHOT_DIR, { recursive:true })
      const shot = await b.send('Page.captureScreenshot', { format:'png' })
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR,name+'-own-list.png'),Buffer.from(shot.data,'base64'))
    }
    await b.run(`OWN=savedDisplayOwn;document.getElementById('owncard').innerHTML=ownCardInner();bindOwnSort()`)
    await b.run(`window.fetch=realFetch;const current=Object.keys((await(await realFetch('/api/own')).json()).own);await realFetch('/api/own',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({act:'reorder',order:['usV2','usGoogle','hkHy2'],expectedOrder:current})})`)
  }
  check(b.errors.length === 0, 'no unhandled browser errors: ' + b.errors.slice(0,2).join(' | '))
} catch (error) { check(false, error.message) }
finally {
  b.close()
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('cfsub-own-list-e2e-')) throw new Error('Unexpected cleanup path')
  fs.rmSync(temp, { recursive:true,force:true })
}
console.log(`Own list browser checks: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
