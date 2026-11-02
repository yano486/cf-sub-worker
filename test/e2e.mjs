// 端到端测试：在真实的无头 Chrome 里操作管理端。
//
//   node test/e2e.mjs            （需要本机装有 Chrome，或用 CHROME=... 指定）
//
// run.cjs 只能检查语法和静态结构，抓不住运行时错误 —— 比如函数名被同名局部变量遮蔽，
// 页面一打开就白屏，语法检查照样全绿。这里用当前的 worker.js 现生成一份演示页
// （Worker 跑在页面里，数据是示例），把每个页面、每种弹窗、主要的增删改都真的点一遍，
// 页面里出现任何未捕获的异常或 console.error 都算失败。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { launch } from '../scripts/cdp.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfsub-e2e-')), 'demo.html')
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-demo.mjs')], { env: { ...process.env, DEMO_OUT: OUT }, stdio: 'inherit' })
const URL0 = pathToFileURL(OUT).href

let pass = 0, fail = 0
const ok = (c, m, extra) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m + (extra ? '  → ' + extra : ''))) }
const sec = t => console.log('\n── ' + t + ' ──')

// 注入到页面里的小工具：等条件成立、取最上层弹窗、点确定
const KIT = `
  window.__w = ms => new Promise(r => setTimeout(r, ms))
  window.__until = async (f, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = f(); if (v) return v } catch (e) {} await __w(40) } return false }
  window.__top = () => [...document.querySelectorAll('.bd:not(.out) .md')].pop() || null
  window.__ok = async () => { const b = __top(); b.querySelector('[data-ok]').click(); await __until(() => !document.body.contains(b) || b.querySelector('.ferr'), 6000); return b }
  window.__close = async () => { const b = __top(); if (b) { b.querySelector('[data-close]').click(); await __until(() => !__top()) } }
  window.__toast = () => [...document.querySelectorAll('.toast:not(.out) span')].map(e => e.textContent).join(' / ')
  document.head.insertAdjacentHTML('beforeend', '<style>*{animation:none!important;transition:none!important}</style>')
`

const b = await launch()
const run = async code => { try { return await b.run(code) } catch (e) { return { __err: e.message } } }
const step = async (label, code) => {
  const v = await run(code)
  if (v && v.__err) return ok(false, label, v.__err.split('\n')[0])
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, c] of Object.entries(v)) ok(c === true, `${label}：${k}`, c === true ? '' : JSON.stringify(c))
  } else ok(v === true, label, JSON.stringify(v))
}
const page = async (hash, opt = {}) => {
  await b.viewport(opt.w || 1100, opt.h || 900, opt)
  await b.open(`${URL0}#${hash}`)
  await b.run(KIT)
}

try {
  sec('节点页')
  await page('node')
  await step('首屏', `return {
    '顶栏统计': /2 个订阅源/.test(document.querySelector('.lede').textContent),
    '两个订阅源': document.querySelectorAll('.uplist.src .up').length === 2,
    '三个自有节点': document.querySelectorAll('.uplist.own .up').length === 3,
    '链式代理一条': document.querySelectorAll('.uplist.chain .up').length === 1,
    '节点列表': document.querySelectorAll('#nodecard .nd').length === 47,
    '用量显示': /GB/.test(document.querySelector('.uplist.src').textContent)
  }`)
  await step('节点搜索', `filterNodes('香港'); const n = document.querySelectorAll('#nodecard .nd:not([hidden])').length; clearNodeQ(); return { '命中 7 个': n === 7, '清空后恢复': document.querySelectorAll('#nodecard .nd:not([hidden])').length === 47 }`)
  await step('节点停用并落库', `const sw = document.querySelector('#nodecard .nd .sw'); const k = sw.closest('.nd').dataset.k
    sw.click(); await __until(() => sw.closest('.nd').classList.contains('off'))
    // 开关是乐观更新：界面先变，请求随后才落库，所以要等服务端真的记下
    let off = false
    for (let i = 0; i < 50 && !off; i++) { const st = await (await fetch('/api/state')).json(); off = st.regions.flatMap(r => r.nodes).find(n => n.key === k).off; if (!off) await __w(40) }
    sw.click(); await __w(200)
    return { '界面变灰': true, '服务端记下': off === true, 'aria 同步': sw.getAttribute('aria-checked') === 'true' }`)
  await step('节点改名', `const nd = document.querySelectorAll('#nodecard .nd')[1]; const k = nd.dataset.k
    nd.querySelector('[aria-label="重命名"]').click(); const inp = nd.querySelector('input.edit'); inp.value = '改过的名字'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); await __until(() => /已重命名/.test(__toast()))
    const row = [...document.querySelectorAll('#nodecard .nd')].find(x => x.dataset.k === k)
    return { '名字更新': row && /改过的名字/.test(row.textContent), '标记自定义': row && !!row.querySelector('.tag') }`)
  await step('本地更新：站内确认与取消', `localStorage.removeItem('cfsub-local-risk-v1'); addUp(); await __until(__top); const form = __top()
    const realFetch = window.fetch, realOpen = window.open, requests = []
    window.fetch = (...args) => { requests.push('fetch'); return realFetch(...args) }
    window.open = (...args) => { requests.push('open'); return realOpen(...args) }
    form.querySelector('#un').value = '保留未保存的名称'
    form.querySelector('#ua .selb').click(); document.querySelector('.selp.portal .selo[data-v="local"]').click()
    const shown = await __until(() => __top() !== form && __top(), 1000)
    if (!shown) { window.fetch = realFetch; window.open = realOpen; await __close(); return { '切换时出现站内风险确认框': false } }
    const warning = shown.textContent
    const untouched = ST.upstreams.length === 2 && form.querySelector('#ua').dataset.v === '1'
    shown.querySelector('[data-x]').click(); await __until(() => __top() === form)
    const result = { '说明 CORS、出口 IP 和 KV 保存边界': /CORS/.test(warning) && /IP/.test(warning) && /KV/.test(warning),
      '确认前不改变方式或订阅源': untouched, '取消恢复原方式': form.querySelector('#ua').dataset.v === '1',
      '取消不丢失表单': form.querySelector('#un').value === '保留未保存的名称', '确认与取消都不发起网络或拉取窗口': requests.length === 0 }
    window.fetch = realFetch; window.open = realOpen
    await __close(); return result`)
  await step('本地更新：重复提醒与本机偏好', `localStorage.removeItem('cfsub-local-risk-v1'); addUp(); await __until(__top); const form = __top()
    const choose = v => { form.querySelector('#ua .selb').click(); document.querySelector('.selp.portal .selo[data-v="' + v + '"]').click() }
    choose('local'); const warning = await __until(() => __top() !== form && __top(), 1000)
    if (!warning) { await __close(); return { '本地方式需要明确确认': false } }
    warning.querySelector('[data-ok]').click(); await __until(() => __top() === form && form.querySelector('#ua').dataset.v === 'local')
    const checkbox = form.querySelector('#ualrisk'), row = checkbox.closest('label')
    const first = !checkbox.checked && row.offsetHeight > 0
    choose('1'); await __w(50); const hidden = row.offsetHeight === 0
    choose('local'); const repeated = await __until(() => __top() !== form && __top(), 1000)
    if (!repeated) { await __close(); return { '未勾选时每次切换都提醒': false } }
    repeated.querySelector('[data-ok]').click(); await __until(() => __top() === form)
    row.querySelector('span:last-child').click(); const saved = checkbox.checked && localStorage.getItem('cfsub-local-risk-v1') === '1'
    choose('0'); await __w(50); choose('local'); await __w(80)
    const skipped = __top() === form && form.querySelector('#ua').dataset.v === 'local'
    await __close(); addUp(); await __until(__top); const second = __top()
    second.querySelector('#ua .selb').click(); document.querySelector('.selp.portal .selo[data-v="local"]').click(); await __w(80)
    const persisted = __top() === second && second.querySelector('#ualrisk').checked
    second.querySelector('#ualrisk').focus(); second.querySelector('#ualrisk').click()
    const reset = localStorage.getItem('cfsub-local-risk-v1') === null
    await __close()
    return { '确定后显示默认未勾选的统一控件': first, '非本地方式隐藏控件': hidden,
      '勾选文字可保存本机偏好': saved, '勾选后跳过确认': skipped, '重新打开表单仍记住偏好': persisted,
      '取消勾选恢复提醒': reset }`)
  await step('本地更新：编辑与存储失败', `localStorage.removeItem('cfsub-local-risk-v1'); editUp('a1'); await __until(__top); const form = __top()
    form.querySelector('#ua .selb').click(); document.querySelector('.selp.portal .selo[data-v="local"]').click()
    const warning = await __until(() => __top() !== form && __top(), 1000)
    if (!warning) { await __close(); return { '编辑使用同一风险确认流程': false } }
    warning.querySelector('[data-ok]').click(); await __until(() => __top() === form)
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(k, v) { if (k === 'cfsub-local-risk-v1') throw new Error('Synthetic storage failure'); return original.call(this, k, v) }
    form.querySelector('#ualrisk').click(); Storage.prototype.setItem = original
    const result = { '存储失败不假装记住偏好': !form.querySelector('#ualrisk').checked && localStorage.getItem('cfsub-local-risk-v1') === null,
      '存储失败有明确提示': /无法保存/.test(__toast()), '没有保存或改动现有源': !ST.upstreams[0].updateMode }
    await __close(); return result`)
  await b.run(`localStorage.setItem('cfsub-local-risk-v1', '1')`)
  await page('node')
  await step('本地更新：刷新后不重复弹窗', `addUp(); await __until(__top); const form = __top()
    form.querySelector('#ua .selb').click(); document.querySelector('.selp.portal .selo[data-v="local"]').click(); await __w(80)
    const result = __top() === form && form.querySelector('#ualrisk').checked && form.querySelector('#ua').dataset.v === 'local'
    form.querySelector('#ualrisk').click(); await __close(); return result`)
  await step('添加订阅源：拉不通就地提示，粘贴后成功', `addUp(); await __until(__top); const m = __top()
    m.querySelector('#uu').value = 'https://blocked.example/sub'; await __ok()
    const err = (m.querySelector('.ferr') || {}).textContent || ''
    const badField = !!m.querySelector('#ut.bad')
    m.querySelector('#ut').value = '  - { name: 测试-日本-1, type: ss, server: 198.51.100.1, port: 443, cipher: aes-128-gcm, password: "p1" }\\n  - { name: 测试-香港-1, type: ss, server: 198.51.100.2, port: 443, cipher: aes-128-gcm, password: "p2" }'
    await __ok(); await __until(() => document.querySelectorAll('.uplist.src .up').length === 3)
    return { '失败原因写在表单里': /拉取失败|粘到下面/.test(err), '定位到粘贴框': badField, '新增一行': document.querySelectorAll('.uplist.src .up').length === 3, '节点数更新': /49/.test(document.querySelector('.lede').textContent) }`)
  await step('删除订阅源', `const id = ST.upstreams[2].id; delUp(id); await __until(__top); await __ok()
    await __until(() => document.querySelectorAll('.uplist.src .up').length === 2); return document.querySelectorAll('.uplist.src .up').length === 2`)
  await step('抓取诊断', `probeUp('a1'); await __until(() => __top() && __top().querySelector('#pbx .uplist'), 6000)
    const t = __top().textContent; await __close(); return { '逐个身份试拉': /逐个身份试拉/.test(t), '解析到节点': /解析到节点/.test(t) }`)
  await step('自有节点：统一添加菜单', `const button = document.querySelector('#ownadd'), menu = document.querySelector('#ownaddmenu')
    if (!button || !menu) return false
    button.click(); const shown = !menu.hidden && button.getAttribute('aria-expanded') === 'true'
    const options = [...menu.querySelectorAll('button')].map(x => x.textContent.trim())
    document.body.click()
    return { '单个按钮包含箭头与添加文案': /添加/.test(button.textContent) && button.querySelector('svg') !== null,
      '点击展开手动添加与 JSON 导入': shown && options.includes('手动添加') && options.includes('批量导入 JSON'),
      '点击外部收起': menu.hidden && button.getAttribute('aria-expanded') === 'false' }`)
  await step('自有节点：菜单键盘与鼠标入口', `const button = document.querySelector('#ownadd'), root = button.parentElement, menu = document.querySelector('#ownaddmenu')
    button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))
    const first = document.activeElement === menu.querySelector('button')
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
    const escaped = menu.hidden && document.activeElement === button
    button.blur(); root.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}))
    const hovered = !menu.hidden; button.click(); const clicked = !menu.hidden
    root.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'})); document.body.click()
    return { '向下键选中第一项': first, 'Esc 关闭并还原焦点': escaped, '鼠标悬停展开': hovered, '悬停后点击仍保持菜单': clicked }`)
  await step('自有节点：JSON 编辑不直接落库', `editOwn('usV2'); await __until(__top); const form = __top(), action = form.querySelector('#ownjson')
    if (!action) { await __close(); return false }
    action.click(); const editor = await __until(() => __top() !== form && __top())
    if (!editor) { await __close(); return false }
    const input = editor.querySelector('#ownjsontext'), example = editor.querySelector('#ownjsonexamples')
    const loaded = JSON.parse(input.value).name === form.querySelector('#on').value
    const oldName = form.querySelector('#on').value
    input.value = JSON.stringify({name:'JSON草稿',type:'ss',s:'json.example.com',p:8388,u:'fictional',cipher:'aes-128-gcm',security:'none'})
    editor.querySelector('[data-ok]').click(); await __until(() => __top() === form && form.querySelector('#on').value === 'JSON草稿')
    const filled = form.querySelector('#os').value === 'json.example.com'
    await __close()
    return { '打开时加载当前草稿 JSON': loaded, '结构示例只读展示': !!example && !example.querySelector('textarea,input'),
      '解析后填回节点表单': filled, '没有点击保存就不修改已有节点': OWN.own.usV2.name === oldName }`)
  await step('自有节点：JSON 取消和协议表单往返', `const results = {}
    for (const type of ['ss','vmess','hysteria2','anytls']) {
      editOwn(null); await __until(__top); const form = __top()
      form.querySelector('#ot .selb').click(); document.querySelector('.selp.portal .selo[data-v="' + type + '"]').click(); await __w(40)
      form.querySelector('#on').value = 'Draft-' + type; form.querySelector('#os').value = type + '.example.com'
      form.querySelector('#ou').value = type === 'vmess' ? '11111111-2222-3333-4444-555555555555' : 'fictional'
      form.querySelector('#ownjson').click(); const editor = await __until(() => __top() !== form && __top())
      const locked = form.inert
      editor.querySelector('[data-x]').click(); await __until(() => __top() === form && !form.inert)
      const retained = form.querySelector('#on').value === 'Draft-' + type && document.activeElement === form.querySelector('#ownjson')
      form.querySelector('#ownjson').click(); const again = await __until(() => __top() !== form && __top())
      again.querySelector('[data-ok]').click(); await __until(() => __top() === form || again.querySelector('.ferr'))
      results[type + ' 草稿往返不丢字段'] = locked && retained && __top() === form && form.querySelector('#ot').dataset.v === type
      if (__top() !== form) { __top().querySelector('[data-close]').click(); await __until(() => __top() === form) }
      await __close()
    }
    return results`)
  await step('自有节点：批量 JSON 预览和保存', `if (typeof importOwnJSON !== 'function') return false
    const existing = JSON.stringify(OWN.own), before = Object.keys(OWN.own).length
    importOwnJSON(); await __until(__top); const form = __top(), input = form.querySelector('#ownjsontext')
    const placeholder = input.value === '' && /proxies|type/.test(input.placeholder)
    input.value = JSON.stringify({proxies:[{name:'JSON-SS',type:'ss',server:'ss.example.com',port:8388,cipher:'aes-128-gcm',password:'fictional'},
      {name:'JSON-VMess',type:'vmess',server:'vm.example.com',port:443,uuid:'11111111-2222-3333-4444-555555555555',alterId:0,cipher:'auto',tls:true,servername:'vm.example.com'}]})
    form.querySelector('#ownjsonparse').click(); await __until(() => /2/.test(form.querySelector('#ownjsonpreview').textContent))
    const untouched = JSON.stringify(OWN.own) === existing
    await __ok(); await __until(() => OWN && Object.keys(OWN.own).length === before + 2)
    const imported = Object.entries(OWN.own).filter(([,n]) => n.name.startsWith('JSON-'))
    const persisted = await (await fetch('/api/own')).json()
    const saved = imported.length === 2 && imported.every(([key,n]) => persisted.own[key].s === n.s)
    for (const [key] of imported) { delOwn(key); await __until(__top); await __ok(); await __until(() => OWN && !OWN.own[key]) }
    return { '空输入框含 JSON 占位例子': placeholder, '预览不写入节点': untouched, '一批节点统一保存并可读取': saved,
      '原有节点完整保留': JSON.stringify(OWN.own) === existing }`)
  await step('自有节点：批量保存期间锁定已确认内容', `importOwnJSON(); await __until(__top); const form = __top()
    const input = form.querySelector('#ownjsontext'), parse = form.querySelector('#ownjsonparse')
    input.value = JSON.stringify({name:'JSON-locked',type:'ss',s:'lock.example',p:8388,u:'fictional',cipher:'aes-128-gcm',security:'none'})
    parse.click()
    const realFetch = window.fetch; let release, observed = false, saves = []
    window.fetch = async (url, opts) => {
      if (url === '/api/own' && (!opts || !opts.method)) { observed = true; await new Promise(r => { release = r }) }
      if (url === '/api/own' && opts && opts.method === 'POST') { saves.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ok:false,msg:'Synthetic save failure'})) }
      return realFetch(url, opts)
    }
    form.querySelector('[data-ok]').click(); await __until(() => observed)
    const locked = input.disabled && parse.disabled && form.querySelector('[data-ok]').disabled
    input.value = JSON.stringify({name:'JSON-unconfirmed',type:'ss',s:'other.example',p:8388,u:'fictional',cipher:'aes-128-gcm',security:'none'})
    parse.click(); const stillLocked = form.querySelector('[data-ok]').disabled
    release(); await __until(() => form.querySelector('.ferr'))
    window.fetch = realFetch
    const names = saves.length === 1 ? Object.values(saves[0].own).map(n => n.name) : []
    const result = { '保存时输入与解析不可操作': locked && stillLocked,
      '只提交已确认批次': names.includes('JSON-locked') && !names.includes('JSON-unconfirmed'),
      '保存失败保留输入': input.value.includes('JSON-unconfirmed') && !input.disabled }
    await __close(); return result`)
  await step('自有节点：预览修改后必须重新解析', `importOwnJSON(); await __until(__top); const form = __top(), input = form.querySelector('#ownjsontext')
    input.value = JSON.stringify({name:'JSON-first',type:'ss',s:'node.example',p:8388,u:'fictional',cipher:'aes-128-gcm'})
    form.querySelector('#ownjsonparse').click(); const enabled = !form.querySelector('[data-ok]').disabled
    input.value = '{}'; input.dispatchEvent(new Event('input',{bubbles:true}))
    const invalidated = form.querySelector('[data-ok]').disabled
    form.querySelector('#ownjsonparse').click(); const error = /节点|type/.test(form.querySelector('#ownjsonpreview').textContent)
    await __close(); return { '成功解析才允许确认': enabled, '修改立即作废旧预览': invalidated, '错误清晰显示不保存': error }`)
  await step('自有节点：POST 等待期间不误报保存失败', `const pending = ownJSONDialog(); await __until(__top); const form=__top(), input=form.querySelector('#ownjsontext')
    input.value=JSON.stringify({name:'JSON-submit',type:'ss',s:'submit.example',p:8388,u:'fictional',cipher:'aes-128-gcm'})
    form.querySelector('#ownjsonparse').click()
    const realFetch=window.fetch; let release, posts=0
    window.fetch=async (url,opts)=>{if(url==='/api/own'&&opts&&opts.method==='POST'){posts++;return new Promise(r=>{release=()=>r(new Response(JSON.stringify({ok:true})))})}return realFetch(url,opts)}
    form.querySelector('[data-ok]').click(); await __until(()=>!!release)
    input.value='{}'; input.dispatchEvent(new Event('input',{bubbles:true})); form.querySelector('#ownjsonparse').click(); form.querySelector('[data-ok]').click()
    release(); const result=await pending; window.fetch=realFetch
    return { '提交时重复操作没有多写': posts===1, '返回固定批次计数不误报失败': result && result.count===1 && !form.querySelector('.ferr') }`)
  await step('自有节点：分享链接导入后保存，再删除', `editOwn(null); await __until(__top); const m = __top()
    m.querySelector('#oimp').value = 'vless://11111111-2222-3333-4444-555555555555@v.example.net:443?security=reality&sni=www.example.com&pbk=PUBKEY0000000000000000000000000000000000000&sid=ab12&type=tcp&flow=xtls-rprx-vision#E2E-VLESS'
    m.querySelector('#oimpb').click(); await __until(() => m.querySelector('#on').value === 'E2E-VLESS')
    const filled = m.querySelector('#opk').value.startsWith('PUBKEY') && m.querySelector('#osid').value === 'ab12'
    await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 4)
    const k = Object.keys(OWN.own).find(x => OWN.own[x].name === 'E2E-VLESS')
    delOwn(k); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 3)
    return { '链接解析填表': filled, '保存后多一行': !!k, '删除后恢复': document.querySelectorAll('.uplist.own .up').length === 3 }`)
  await step('Reality导入：后量子能力字段经过JSON和表单保存不丢失', `const uuid='11111111-2222-3333-4444-555555555555',pk='A'.repeat(43),count=Object.keys(OWN.own).length
    editOwn(null);await __until(__top);const form=__top();form.querySelector('#ownjson').click();const editor=await __until(()=>__top()!==form&&__top())
    editor.querySelector('#ownjsontext').value='    - { name: Reality-PQ-demo, type: vless, server: safe.example, port: 25565, uuid: '+uuid+', udp: true, flow: xtls-rprx-vision, tls: true, skip-cert-verify: false, client-fingerprint: firefox, servername: tls.example, reality-opts: { public-key: '+pk+', short-id: 0592b9f3, support-x25519mlkem768: true } }'
    editor.querySelector('[data-ok]').click();await __until(()=>__top()===form&&form.querySelector('#on').value==='Reality-PQ-demo')
    const filled=form.querySelector('#orealitypq')&&form.querySelector('#orealitypq').dataset.v==='1'&&form.querySelector('#osid').value==='0592b9f3'
    await __ok();await __until(()=>OWN&&Object.keys(OWN.own).length===count+1);const key=Object.keys(OWN.own).find(k=>OWN.own[k].name==='Reality-PQ-demo')
    const saved=OWN.own[key].realityPQ===true&&!OWN.own[key].clientOptions,url=new URL(OWN.links[key])
    const shared=url.searchParams.get('security')==='reality'&&url.searchParams.get('pbk')===pk&&url.searchParams.get('sid')==='0592b9f3'&&url.searchParams.get('fp')==='firefox'
    editOwn(key);await __until(__top);let edit=__top();edit.querySelector('#orealitypq .selb').click();document.querySelector('.selp.portal .selo[data-v="0"]').click();await __ok();await __until(()=>OWN&&OWN.own[key].realityPQ===false)
    editOwn(key);await __until(__top);edit=__top();const reopened=edit.querySelector('#orealitypq').dataset.v==='0';edit.querySelector('#orealitypq .selb').click();document.querySelector('.selp.portal .selo[data-v=""]').click();await __ok();await __until(()=>OWN&&OWN.own[key].realityPQ===undefined)
    const restored=OWN.own[key].realityPQ===undefined
    delOwn(key);await __until(__top);await __ok();await __until(()=>OWN&&!OWN.own[key])
    return {'单节点JSON填回识别true及ShortId':filled,'保存保留布尔值且不产生多余专用参数':saved,'分享保留标准Reality参数':shared,'编辑可保留false并恢复默认':reopened&&restored}`)
  await step('证书风险：每次勾选立即确认且保存不重复提醒', `const before = Object.keys(OWN.own).length; editOwn(null); await __until(__top); const form=__top()
    form.querySelector('#ot .selb').click(); document.querySelector('.selp.portal .selo[data-v="anytls"]').click(); await __w(40)
    form.querySelector('#on').value='TLS-risk-demo'; form.querySelector('#os').value='risk.example'; form.querySelector('#ou').value='fictional'
    form.querySelector('#ownadvanced').open=true
    const realFetch=window.fetch; let writes=0
    window.fetch=(url,opts)=>{if(url==='/api/own'&&opts&&opts.method==='POST')writes++;return realFetch(url,opts)}
    form.querySelector('#oinsecure').click(); const warning=await __until(()=>__top()!==form&&__top(),1000)
    if(!warning){window.fetch=realFetch;await __close();return {'勾选时立即显示站内风险提示':false}}
    const text=warning.textContent, one=warning.querySelectorAll('button').length===1&&warning.querySelector('[data-ok]').textContent==='已了解'
    warning.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); const blocked=__top()===warning&&writes===0&&form.inert
    warning.querySelector('[data-ok]').click(); await __until(()=>__top()===form&&!form.inert)
    form.querySelector('#oinsecure').click(); const offQuiet=__top()===form&&!form.querySelector('#oinsecure').checked
    form.querySelector('#oinsecure').click(); const again=await __until(()=>__top()!==form&&__top(),1000)
    const repeated=!!again; if(again)again.querySelector('[data-ok]').click(); await __until(()=>__top()===form&&!form.inert)
    form.querySelector('[data-ok]').click(); await __until(()=>OWN&&Object.keys(OWN.own).length===before+1)
    const key=Object.keys(OWN.own).find(k=>OWN.own[k].name==='TLS-risk-demo'), saved=key&&OWN.own[key].insecure===true
    const noDuplicate=!__top()
    window.fetch=realFetch; delOwn(key); await __until(__top); await __ok(); await __until(()=>OWN&&!OWN.own[key])
    return {'只有已了解一个按钮':one,'内容明确说明中间人攻击':/中间人攻击/.test(text),'Esc不跳过且确认前不写入':blocked,'确认后才保存显式跳过校验':saved,'取消勾选不打扰':offQuiet,'再次勾选仍提醒':repeated,'保存不重复弹已确认的提醒':noDuplicate}`)
  await step('证书风险：JSON 批量只提示一次且保留输入', `const pending=ownJSONDialog(); await __until(__top); const form=__top(),input=form.querySelector('#ownjsontext')
    input.value='"outbounds":'+JSON.stringify([{tag:'Risk-A',type:'anytls',server:'a.example',server_port:443,password:'fictional',tls:{enabled:true,insecure:true,fragment:true,record_fragment:true}},{tag:'Risk-B',type:'hysteria2',server:'b.example',server_ports:['35000:39000'],hop_interval:'30s',password:'fictional',tls:{enabled:true,insecure:true,fragment:true,record_fragment:true}},{type:'direct',tag:'direct'}])+',';form.querySelector('#ownjsonparse').click()
    const text=input.value,realFetch=window.fetch;let posts=0
    window.fetch=async(url,opts)=>{if(url==='/api/own'&&opts&&opts.method==='POST'){posts++;return new Response(JSON.stringify({ok:true}))}return realFetch(url,opts)}
    form.querySelector('[data-ok]').click();const warning=await __until(()=>__top()!==form&&__top(),1000)
    if(!warning){window.fetch=realFetch;await __close();return {'JSON带跳过校验也提醒':false}}
    const unchanged=input.value===text&&posts===0
    warning.querySelector('[data-ok]').click();const result=await pending;window.fetch=realFetch
    return {'输入保持原样且确认前不写入':unchanged,'整批只需一次确认并一次保存':posts===1&&result.count===2}`)
  await step('配置自适应：13个协议格式示例均可直接解析', `const pending=ownJSONDialog();await __until(__top);const form=__top(),examples=[...form.querySelectorAll('#ownjsonexamples pre')]
    const results=examples.map(e=>parseOwnJSON(e.textContent));const labels=form.querySelector('#ownjsonexamples').textContent
    const result={'示例不是含糊的本站节点':!labels.includes('本站节点'),'13个真实组合齐全':examples.length===13,
      '每个示例都能识别为一个节点':results.every(r=>r.ok&&r.nodes.length===1)}
    form.querySelector('[data-x]').click();await pending;return result`)
  await step('分享：保留专用参数仍可明确确认复制基础链接', `const key='copy-options-demo', advanced={name:'Copy-options',type:'anytls',s:'copy.example',p:443,u:'fictional',security:'tls',insecure:false,clientOptions:{singbox:{tls:{fragment:true,record_fragment:true}}}}
    const response=await (await fetch('/api/own',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({own:{...OWN.own,[key]:advanced}})})).json()
    if(!response.ok)return false;OWN=null;await dash(true);await __until(()=>OWN&&OWN.own[key])
    const button=document.querySelector('.uplist.own [onclick*="'+key+'"][aria-label="复制分享链接"]'), originalCopy=copyText, copied=[]
    copyText=async text=>{copied.push(text);return true}
    copyOwnLink(key,button);const warning=await __until(__top,1000)
    if(!warning){copyText=originalCopy;delOwn(key);await __until(__top);await __ok();return {'无需删除参数可进入复制确认':false}}
    const explicit=/专用参数/.test(warning.textContent)&&/基础/.test(warning.textContent)&&copied.length===0
    warning.querySelector('[data-x]').click();await __until(()=>!__top());const cancelled=copied.length===0
    copyOwnLink(key,button);await __until(__top);await __ok();await __until(()=>copied.length===1)
    copyText=originalCopy;const read=await(await fetch('/api/own')).json(), kept=JSON.stringify(read.own[key].clientOptions)===JSON.stringify(advanced.clientOptions)
    const basic=copied.length===1&&copied[0].startsWith('anytls://')
    delOwn(key);await __until(__top);await __ok();await __until(()=>OWN&&!OWN.own[key])
    return {'复制前说明基础链接不含专用参数':explicit,'取消不会复制':cancelled,'确认后可复制有效基础URI':basic,'原节点专用参数未被删除':kept}`)
  await step('分享ECH：JSON与链接导入路径输出一致', `const ech='ech.example+https://dns.example/dns-query?value=a%2Bb&mode=full',uuid='11111111-2222-3333-4444-555555555555'
    const own={name:'ECH-json-proxy',type:'vless',s:'safe.example',p:443,u:uuid,security:'tls',net:'ws',path:'/',flow:'',encryption:'none',insecure:false}
    const options={xray:{tlsSettings:{echConfigList:ech,echForceQuery:'full'},finalmask:{tcp:[{type:'fragment',settings:{packets:'tlshello'}}]}}}
    const proxy={...own,clientOptions:options},jp={...own,name:'ECH-uri-jp',importExtras:{query:[['ech',ech]]}}
    const result=await(await fetch('/api/own',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({own:{...OWN.own,echproxy:proxy,echjp:jp}})})).json()
    if(!result.ok)return false;OWN=null;await dash(true);await __until(()=>OWN&&OWN.own.echproxy)
    const originalCopy=copyText,copied=[];copyText=async text=>{copied.push(text);return true}
    const button=document.querySelector('.uplist.own [onclick*="echproxy"][aria-label="复制分享链接"]')
    copyOwnLink('echproxy',button);const warning=await __until(__top);const notice=/ECH.*ech/.test(warning.textContent)&&/finalmask/.test(warning.textContent)
    warning.querySelector('[data-ok]').click();await __until(()=>copied.length===1);copyText=originalCopy
    const a=new URL(copied[0]),b=new URL(OWN.links.echjp),kept=JSON.stringify(OWN.own.echproxy.clientOptions)===JSON.stringify(options)
    for(const key of ['echproxy','echjp']){delOwn(key);await __until(__top);await __ok();await __until(()=>OWN&&!OWN.own[key])}
    return {'提示明确说明ECH保留其他专用项可能省略':notice,'两种导入路径分享含同值ech':a.searchParams.get('ech')===ech&&b.searchParams.get('ech')===ech,
      '特殊字符没有二次编码或解码':a.searchParams.get('ech')===ech,'原配置仍完整保留':kept}`)
  await step('兼容输出：明确确认后下发基础节点且原参数不丢失', `const key='compat-mode-demo',options={xray:{tlsSettings:{echConfigList:'ech.example+https://dns.example/dns-query',echForceQuery:'full'},finalmask:{tcp:[{type:'fragment',settings:{packets:'tlshello',length:'100-200',delay:'10-20'}}]}}}
    const own={name:'Compat-mode-demo',type:'vless',s:'safe.example',p:443,u:'11111111-2222-3333-4444-555555555555',security:'tls',net:'ws',path:'/',flow:'',encryption:'none',insecure:false,clientOptions:options}
    await fetch('/api/own',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({own:{...OWN.own,[key]:own}})});OWN=null;await dash(true);await __until(()=>OWN&&OWN.own[key])
    const lines=[...document.querySelectorAll('#owncard .compat-warning')].filter(e=>e.textContent.includes(own.name))
    editOwn(key);await __until(__top);const form=__top(),toggle=form.querySelector('#obasic')
    if(!toggle){await __close();delOwn(key);await __until(__top);await __ok();return {'编辑器提供基础兼容输出开关':false}}
    toggle.click();const warning=await __until(()=>__top()!==form&&__top(),1000)
    if(!warning){await __close();return {'开启前必须明确确认':false}}
    const explained=/ECH/.test(warning.textContent)&&/隐私/.test(warning.textContent)&&!toggle.checked
    warning.querySelector('[data-x]').click();await __until(()=>__top()===form&&!form.inert);const cancelled=!toggle.checked
    toggle.click();await __until(()=>__top()!==form);__top().querySelector('[data-ok]').click();await __until(()=>__top()===form&&toggle.checked&&!form.inert)
    await __ok();await __until(()=>OWN&&OWN.own[key]&&OWN.own[key].compatibilityMode==='basic')
    const kept=JSON.stringify(OWN.own[key].clientOptions)===JSON.stringify(options)
    const preview=await(await fetch('/api/preview?pf=main&fmt=share')).json()
    const present=preview.ok&&atob(preview.body).includes(encodeURIComponent(own.name))
    const notices=(preview.warnings||[]).some(w=>w.name===own.name&&/基础兼容/.test(w.reason))
    editOwn(key);await __until(__top);const edit=__top();edit.querySelector('#obasic').click();const quiet=__top()===edit;await __ok();await __until(()=>OWN&&OWN.own[key]&&OWN.own[key].compatibilityMode==='strict')
    const strict=await(await fetch('/api/preview?pf=main&fmt=share')).json();const blocked=!atob(strict.body).includes(encodeURIComponent(own.name))
    delOwn(key);await __until(__top);await __ok();await __until(()=>OWN&&!OWN.own[key])
    return {'重复格式提示按实际省略内容合并':lines.length===2&&lines.some(e=>e.textContent.includes(' / ')),'明确说明省略参数与隐私影响':explained,'取消不启用':cancelled,
      '启用后订阅含基础节点并保留参数':present&&kept,'预览说明实际省略':notices,'关闭立即回到完整参数模式':quiet&&blocked}`)
  await step('兼容输出：JSON声明basic也不能跳过明确确认', `const pending=ownJSONDialog();await __until(__top);const form=__top(),input=form.querySelector('#ownjsontext')
    input.value=JSON.stringify({name:'JSON-basic-consent',type:'vless',s:'safe.example',p:443,u:'11111111-2222-3333-4444-555555555555',security:'tls',net:'ws',path:'/',flow:'',encryption:'none',insecure:false,compatibilityMode:'basic',clientOptions:{xray:{finalmask:{tcp:[{type:'fragment',settings:{packets:'tlshello'}}]}}}})
    form.querySelector('#ownjsonparse').click();const original=window.fetch;let posts=0
    window.fetch=async(url,opts)=>{if(url==='/api/own'&&opts&&opts.method==='POST'){posts++;return new Response(JSON.stringify({ok:true}))}return original(url,opts)}
    form.querySelector('[data-ok]').click();const warning=await __until(()=>__top()!==form&&__top())
    const before=posts===0&&form.inert&&/所有订阅/.test(warning.textContent)
    warning.querySelector('[data-x]').click();await __until(()=>__top()===form&&form.querySelector('.ferr'));const kept=input.value.includes('JSON-basic-consent')&&posts===0
    form.querySelector('[data-ok]').click();await __until(()=>__top()!==form);__top().querySelector('[data-ok]').click();const result=await pending;window.fetch=original
    return {'确认前没有保存请求':before,'取消保留输入且不写入':kept,'重新确认后只保存一次':posts===1&&result.count===1}`)
  await step('配置自适应：Clash单行与Xray专用字段保留', `const uuid='11111111-2222-3333-4444-555555555555'
    const line='- { name: Test, type: vless, server: safe.example, port: 443, uuid: '+uuid+', alterId: 0, cipher: auto, udp: true, flow: null, encryption: none, tls: true, skip-cert-verify: false, servername: tls.example, client-fingerprint: safari, network: ws, ws-opts: { path: /, headers: { Host: tls.example } } }'
    const clash=parseOwnJSON(line), multiple=parseOwnJSON('    '+line+'\\n    '+line.replace('Test','Second')), clipped=parseOwnJSON(line+'\\n    '+line.replace('Test','Clipped'))
    const xray=parseOwnJSON('"outbounds":'+JSON.stringify([{tag:'proxy',protocol:'vless',settings:{address:'safe.example',port:443,id:uuid,encryption:'none',email:''},streamSettings:{network:'ws',security:'tls',tlsSettings:{serverName:'tls.example',fingerprint:'chrome',echConfigList:'ech.example+https://dns.example/dns-query',echForceQuery:'full'},wsSettings:{path:'/',host:'tls.example',headers:{'User-Agent':'safari'}},finalmask:{tcp:[{type:'fragment',settings:{header:null,value:null,password:null,url:null,stunServers:null,packetSize:null,packets:'tlshello',length:'100-200',delay:'10-20',lengths:['100-200'],delays:['10-20'],maxSplit:0,reset:null,noise:null}}]}},mux:{enabled:false,concurrency:-1}},{protocol:'freedom',tag:'direct'},{protocol:'blackhole',tag:'block'}])+',')
    return {'单行YAML和空Flow被正确识别':clash.ok&&clash.nodes[0].net==='ws'&&clash.nodes[0].flow==='',
      '多行公共缩进和首行缺失缩进均识别':multiple.ok&&multiple.nodes.length===2&&clipped.ok&&clipped.nodes.length===2,
      'Xray片段无需外壳且跳过非代理出站':xray.ok&&xray.nodes.length===1,
      'ECH和finalmask没有被删除':xray.ok&&xray.nodes[0].clientOptions.xray.tlsSettings.echForceQuery==='full'&&xray.nodes[0].clientOptions.xray.finalmask.tcp[0].settings.header===null}`)
  await step('自有节点：WebSocket 传输切换表单字段并能保存', `editOwn(null); await __until(__top); const m = __top()
    m.querySelector('#osecurity .selb').click(); await __w(50); document.querySelector('.selp.portal .selo[data-v="tls"]').click(); await __w(50)
    m.querySelector('#onet .selb').click(); await __w(50); document.querySelector('.selp.portal .selo[data-v="ws"]').click(); await __w(50)
    m.querySelector('#ownadvanced').open = true
    m.querySelector('#oflow .selb').click(); await __w(50); document.querySelector('.selp.portal .selo[data-v=""]').click(); await __w(50)
    const swapped = m.querySelector('#fr').hidden && !m.querySelector('#fw').hidden
    m.querySelector('#on').value = 'E2E-WS'; m.querySelector('#os').value = 'cdn.e2e.example'; m.querySelector('#ou').value = '11111111-2222-3333-4444-555555555555'
    m.querySelector('#osni').value = 'cdn.e2e.example'; m.querySelector('#opath').value = '/ws'
    await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 4)
    const k = Object.keys(OWN.own).find(x => OWN.own[x].name === 'E2E-WS'); const n = OWN.own[k]
    const label = /VLESS WS/.test(document.querySelector('.uplist.own').textContent)
    delOwn(k); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('.uplist.own .up').length === 3)
    return { '选 WebSocket 后显示路径而不是 Reality 公钥': swapped, '按 ws 保存': n.net === 'ws' && n.path === '/ws' && !n.pk, '列表里显示为 VLESS WS': label }`)
  await step('自有节点：输入框对齐与主题勾选项', `editOwn(null); await __until(__top); const m = __top()
    const a = m.querySelector('#os').getBoundingClientRect(), p = m.querySelector('#op').getBoundingClientRect()
    m.querySelector('#ownadvanced').open = true
    const input = m.querySelector('#oudp'), label = input.closest('label'), box = input.nextElementSibling
    const was = input.checked; label.querySelector('span:last-child').click()
    const toggled = input.checked !== was; label.querySelector('span:last-child').click()
    const css = getComputedStyle(box), display = getComputedStyle(label).display
    const sameSize = css.width === '18px' && css.height === '18px'
    await __close()
    return { '顶部和底部对齐': Math.abs(a.top - p.top) < 1 && Math.abs(a.bottom - p.bottom) < 1, '端口定宽': Math.abs(p.width - 112) < 1, '点击文字改变真实勾选状态': toggled && input.checked === was, '统一勾选尺寸': sameSize, '标签使用行布局': display === 'flex' }`)
  await step('自有节点表单校验', `editOwn(null); await __until(__top); const m = __top(); m.querySelector('#on').value = 'x'; m.querySelector('#os').value = 'a.example'; m.querySelector('#op').value = '99999'
    await __ok(); const e = (m.querySelector('.ferr') || {}).textContent || ''; await __close(); return /1-65535/.test(e)`)
  await step('链式代理编辑弹窗', `editChain('c1'); await __until(__top); const t = __top().textContent; await __close(); return /中转/.test(t) && /落地/.test(t)`)
  await step('主题切换', `const t = () => document.documentElement.dataset.theme
    cycleTheme(); const l = t() + '/' + localStorage.getItem('theme'); cycleTheme(); const d = t() + '/' + localStorage.getItem('theme'); cycleTheme()
    return { '跟随系统→浅色': l === 'light/light', '浅色→深色': d === 'dark/dark', '深色→跟随系统': localStorage.getItem('theme') === null && t() === 'light' }`)

  sec('订阅页')
  await page('sub')
  await step('三份订阅', `return document.querySelectorAll('.prof').length === 3`)
  await step('手机订阅的严格策略提示', `return /Google/.test((document.querySelectorAll('.prof')[1].querySelector('.seen.warn') || {}).textContent || '')`)
  await step('地区标签不误报', `return !/当前无节点/.test(document.querySelectorAll('.prof')[1].textContent)`)
  await step('切换客户端', `pickClient('singbox'); await __until(() => /fmt=singbox/.test(document.getElementById('su0').textContent)); const u = document.getElementById('su0').textContent; pickClient('clash'); await __w(200); return /^https:\\/\\/sub\\.example\\.com\\/sub\\?token=.+&fmt=singbox$/.test(u)`)
  await step('二维码', `qrSub(0); await __until(() => __top() && __top().querySelector('#qrv svg')); const m = __top()
    const n1 = m.querySelector('#qrv path').getAttribute('d').length; m.querySelectorAll('#qrm button')[1].click(); await __w(100)
    const n2 = m.querySelector('#qrv path').getAttribute('d').length; const u = m.querySelector('#qru').textContent; await __close()
    return { '画出二维码': n1 > 100, '可切到一键导入': n2 !== n1 && /^clash:\\/\\/install-config/.test(u) }`)
  await step('配置预览（四种格式）', `previewSub(0); await __until(() => __top() && /个节点/.test(__top().querySelector('#pvs').textContent)); const m = __top(); const r = {}
    for (const f of ['clash', 'shadowrocket', 'singbox', 'share']) {
      m.querySelector('#pvf button[data-f="' + f + '"]').click(); await __until(() => /个节点/.test(m.querySelector('#pvs').textContent) && m.querySelector('#pvc').textContent.length > 200)
      r[f] = m.querySelector('#pvc').textContent.length > 200
    }
    const sb = m.querySelector('#pvc').textContent; m.querySelector('#pvf button[data-f="singbox"]').click(); await __until(() => m.querySelector('#pvc').textContent.trim().startsWith('{'))
    let json = false; try { JSON.parse(m.querySelector('#pvc').textContent); json = true } catch (e) {}
    await __close(); return { Clash: r.clash, Shadowrocket: r.shadowrocket, 'sing-box 是合法 JSON': json, '通用格式已解码': r.share && /:\\/\\//.test(sb) }`)
  await step('预览切格式不闪：逐帧采样，布局一丝不动、内容从不清空', `previewSub(0)
    await __until(() => __top() && __top().querySelector('#pvc').dataset.f === 'clash', 6000)
    const m = __top(), pre = m.querySelector('#pvc'), st = m.querySelector('#pvs')
    const box = () => [Math.round(m.getBoundingClientRect().height), Math.round(pre.getBoundingClientRect().height), Math.round(st.getBoundingClientRect().height)].join('/')
    const seen = new Set([box()]); let minLen = pre.textContent.length, frames = 0, run = true
    // 每一帧都量：弹窗、代码区、统计行的高度，以及代码区里还剩多少字
    const tick = () => { if (!run) return; frames++; seen.add(box()); minLen = Math.min(minLen, pre.textContent.length); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    // DOM 每变一次也量一次，连帧与帧之间的中间态都不放过
    const mo = new MutationObserver(() => { seen.add(box()); minLen = Math.min(minLen, pre.textContent.length) })
    mo.observe(pre, { childList: true, subtree: true, characterData: true }); mo.observe(st, { childList: true, subtree: true })
    for (const f of ['singbox', 'shadowrocket', 'share', 'clash', 'singbox', 'share', 'clash']) {
      m.querySelector('#pvf button[data-f="' + f + '"]').click()
      seen.add(box()); minLen = Math.min(minLen, pre.textContent.length)      // 点下去的同一刻：响应还没回来
      await __until(() => pre.dataset.f === f, 6000)
      await __w(60)
    }
    // 预取完成后再切：同一帧里就该换好，不经过任何加载态
    await __w(300)
    m.querySelector('#pvf button[data-f="singbox"]').click()
    const instant = pre.dataset.f === 'singbox' && pre.textContent.trim().startsWith('{')
    // 滚动位置按格式记住：在 sing-box 里往下滚，切走再切回来还在原处
    pre.scrollTop = 400; m.querySelector('#pvf button[data-f="clash"]').click(); m.querySelector('#pvf button[data-f="singbox"]').click()
    const kept = Math.abs(pre.scrollTop - 400) <= 2
    run = false; mo.disconnect()
    const colored = !!pre.querySelector('.k')
    await __close()
    return { '弹窗与代码区、统计行的高度始终不变': seen.size === 1 || [...seen].join(' | '), '任何一刻代码区都不是空的': minLen > 500 || minLen,
      '采样到了足够多的帧': frames > 10 || frames, '看过的格式再切回来是瞬间的': instant, '切回来时滚动位置还在': kept, 'sing-box 也有语法着色': colored }`)
  await step('新建订阅并拉一次，出现拉取记录', `editProf(null); await __until(__top); const m = __top(); m.querySelector('#sn').value = 'E2E'; await __ok()
    await __until(() => document.querySelectorAll('.prof').length === 4)
    const i = PRF.profiles.findIndex(x => x.name === 'E2E'); await fetch('/sub?token=' + PRF.profiles[i].token)
    PRF = null; await dash(true); await __until(() => /拉取/.test(document.querySelectorAll('.prof')[i].querySelector('.seen:last-child').textContent))
    showHits(i); await __until(__top); const n = __top().querySelectorAll('.hit').length; await __close()
    delProf(i); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('.prof').length === 3)
    return { '新建成功': true, '拉取记录一条': n === 1, '删除成功': document.querySelectorAll('.prof').length === 3 }`)
  await step('编辑订阅：token 不合法就地报错', `editProf(0); await __until(__top); const m = __top(); m.querySelector('#stk').value = 'short'; await __ok()
    const e = (m.querySelector('.ferr') || {}).textContent || ''; await __close(); return /16-64/.test(e) && !!m.querySelector('#stk.bad')`)
  await step('停用 / 启用订阅', `const sw = document.querySelector('.prof .sw'); sw.click(); await __until(() => document.querySelector('.prof').classList.contains('off'))
    sw.click(); await __until(() => !document.querySelector('.prof').classList.contains('off')); return true`)

  sec('分流策略')
  await page('pol')
  await step('策略列表', `return { '12 条': document.querySelectorAll('#pollist .pol').length === 12, '没有失效误报': !document.querySelector('#body .alert'), '地区目标有名字': /日本/.test(document.querySelector('#pollist .pol .tgts').textContent) }`)
  await step('新建策略：缺规则就地报错，补上后保存', `editPol(null); await __until(__top); const m = __top(); m.querySelector('#pn').value = '🧪 E2E'; await __ok()
    const e = (m.querySelector('.ferr') || {}).textContent || ''; m.querySelector('#pd').value = 'e2e.example'; await __ok()
    await __until(() => document.querySelectorAll('#pollist .pol').length === 13); return { '缺规则提示': /至少要有一条/.test(e), '保存成功': document.querySelectorAll('#pollist .pol').length === 13 }`)
  await step('规则测试', `await runMatch('www.e2e.example'); const a = document.getElementById('mres').textContent
    await runMatch('https://www.youtube.com/watch?v=1'); const y = document.getElementById('mres').textContent
    await runMatch('192.0.2.77'); const ip = document.getElementById('mres').textContent
    return { '命中新策略': /E2E/.test(a), 'YouTube 走日本': /YouTube/.test(y) && /日本/.test(y), 'IP 落到兜底并说明': /兜底/.test(ip) && /IP/.test(ip) }`)
  await step('删除新策略', `const i = POL.policies.findIndex(p => p.name === '🧪 E2E'); delPol(i); await __until(__top); await __ok(); await __until(() => document.querySelectorAll('#pollist .pol').length === 12); return true`)
  // 多选勾完不收起，面板挂在 body 上。这时直接点保存，勾选不能丢（曾经存成空数组）
  await step('多选目标：面板没收起就点保存，勾选照样落库', `const before = JSON.parse(JSON.stringify(POL.policies[0].target))
    editPol(0); await __until(__top); const m = __top()
    m.querySelector('#pt .selb').click(); await __w(50)
    const o = [...document.querySelectorAll('.selp.portal .selo')].find(x => !x.classList.contains('on'))
    const v = o.dataset.v; o.click(); await __w(50)
    const open = !!document.querySelector('.selp.portal:not([hidden])')
    await __ok(); await __until(() => !__top())
    const t = POL.policies[0].target
    POL.policies[0].target = before; await savePol('已恢复')
    return { '点保存时面板仍展开': open, '新勾的目标已保存': Array.isArray(t) && t.includes(v) }`)
  await step('切到某份订阅并改为专属、再改回继承', `document.querySelector('#pfsel .selb').click(); await __w(50); document.querySelector('.selp.portal .selo[data-v="phone"]').click()
    await __until(() => PF === 'phone' && POL && document.querySelector('#pollist'))
    detachPol(); await __until(__top); await __ok(); await __until(() => POL && POL.inherit === false)
    inheritPol(); await __until(__top); await __ok(); await __until(() => POL && POL.inherit === true)
    return true`)
  await step('改过的表单按 Esc 不关', `editPol(0); await __until(__top); const m = __top(); m.querySelector('#pn').value += 'x'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await __w(100); const still = document.body.contains(m); await __close(); return still`)

  sec('域名库')
  await page('lib')
  await step('搜索域名', `filterLib('netflix.com'); return /1 个集合/.test(document.getElementById('lqc').textContent)`)
  await step('改内置集合后恢复', `filterLib(''); editLib('media'); await __until(__top); __top().querySelector('#ld').value += '\\nextra.e2e.example'; await __ok()
    await __until(() => /已修改/.test(document.querySelector('.uplist.lib .up[data-k="media"]').textContent))
    restoreLib('media'); await __until(__top); await __ok(); await __until(() => !/已修改/.test(document.querySelector('.uplist.lib .up[data-k="media"]').textContent))
    return true`)
  await step('被引用的自定义集合删不掉', `editLib(null); await __until(__top); const m = __top(); m.querySelector('#ln').value = 'E2E集'; m.querySelector('#ld').value = 'a.e2e.example'; await __ok()
    const k = Object.keys(POL.lib).find(x => POL.lib[x].name === 'E2E集')
    const r = await (await fetch('/api/policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policies: [...POL.policies, { name: '引用E2E', target: 'all', presets: [k] }] }) })).json()
    POL = null; await dash(true)
    delLib(k); await __until(__top); const d = __top(); await __ok(); const e = (d.querySelector('.ferr') || {}).textContent || ''; await __close()
    return { '拒绝并点名': /引用E2E/.test(e) }`)

  sec('设置')
  await page('set')
  await step('站点设置：非法 IP 就地报错', `editSettings(); await __until(__top); const m = __top(); m.querySelector('#stip').value = '1.2.3'; await __ok()
    const e = (m.querySelector('.ferr') || {}).textContent || ''; m.querySelector('#stip').value = '203.0.113.10'; await __ok()
    return { '报错': /IPv4/.test(e), '改对后保存': !document.body.contains(m) }`)
  await step('DNS：新增一条域名指派并保存', `editDns(); await __until(__top); const m = __top(); addDnsPol(); m.querySelector('#dpol [data-pi]:last-child .pdm').value = '+.e2e.example'
    await __ok(); return !document.body.contains(m) && /e2e\\.example/.test(document.getElementById('body').textContent)`)
  await step('备份导出与恢复', `const bk = (await (await fetch('/api/backup')).json()).backup
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'changed.example' }) })
    const r = await (await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup: bk }) })).json()
    SET = null; await dash(true); return { '恢复成功': r.ok === true, '配置回来了': /sub\\.example\\.com/.test(document.getElementById('body').textContent) }`)
  await step('让其它设备下线', `revokeOthers(); await __until(__top); await __ok(); return await __until(() => /下线/.test(__toast()))`)

  sec('窄屏（390px）')
  for (const t of ['node', 'sub', 'pol', 'lib', 'set']) {
    await page(t, { w: 390, h: 844, mobile: true })
    await step(`「${t}」页不横向溢出`, `return document.documentElement.scrollWidth <= innerWidth + 1 || document.documentElement.scrollWidth + ' > ' + innerWidth`)
  }
  await step('弹窗在窄屏是底部抽屉', `editSettings(); await __until(__top); const r = __top().getBoundingClientRect(); await __close(); return Math.abs(r.bottom - innerHeight) < 2`)
  await step('新建节点窄屏字段堆叠且不溢出', `editOwn(null); await __until(__top); const m = __top(), ct = m.querySelector('.ct')
    const a = m.querySelector('#os').getBoundingClientRect(), p = m.querySelector('#op').getBoundingClientRect()
    const overflow = ct.scrollWidth > ct.clientWidth + 1
    await __close(); return { '地址端口上下排列': p.top >= a.bottom, '左右同宽': Math.abs(a.width - p.width) < 1 && Math.abs(a.left - p.left) < 1, '没有横向滚动': !overflow }`)

  sec('暗色')
  await page('node', { dark: true })
  await step('跟随系统进入暗色', `return document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor === 'rgb(27, 26, 24)'`)

  sec('本地拉取风险提示：布局与键盘')
  for (const [name, opt] of [['desktop-light', { w:1100, h:900 }], ['mobile-dark', { w:390, h:844, mobile:true, dark:true }]]) {
    await page('node', opt)
    await step(name + ' 风险确认布局', `localStorage.removeItem('cfsub-local-risk-v1'); addUp(); await __until(__top); const form = __top()
      form.querySelector('#ua .selb').click(); document.querySelector('.selp.portal .selo[data-v="local"]').click()
      const warning = await __until(() => __top() !== form && __top(), 1000)
      if (!warning) return false
      await __until(() => warning.contains(document.activeElement) && !document.querySelector('.bd.out'))
      const r = warning.getBoundingClientRect(), ct = warning.querySelector('.ct')
      const first = warning.querySelector('.bdy > :first-child'), body = warning.querySelector('.bdy')
      const compact = first.getBoundingClientRect().top - ct.getBoundingClientRect().top
      return { '弹窗在视口内': r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
        '正文不横向溢出': ct.scrollWidth <= ct.clientWidth + 1,
        '正文开头没有叠加大块空白': compact >= 0 && compact <= 12,
        '段落间距不重复叠加': getComputedStyle(body).gap === '14px' && getComputedStyle(body.querySelector('p')).marginTop === '0px',
        '拉取方式显示简版完整链路': warning.textContent.includes('当前网络请求订阅 → 内容返回浏览器 → 上传 Worker → 保存到 KV'),
        '底层表单不可误操作': form.inert,
        '两层弹窗标题关联独立': warning.getAttribute('aria-labelledby') !== form.getAttribute('aria-labelledby') }`)
    if (process.env.E2E_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.E2E_SCREENSHOT_DIR, { recursive:true })
      const shot = await b.send('Page.captureScreenshot', { format:'png' })
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR, name + '-warning.png'), Buffer.from(shot.data, 'base64'))
    }
    await step(name + ' 复选框样式', `const warning = __top(); warning.querySelector('[data-ok]').click()
      await __until(() => __top() && !__top().inert && __top().querySelector('#ua').dataset.v === 'local')
      await __until(() => !document.body.contains(warning))
      const form = __top(), input = form.querySelector('#ualrisk'), row = input.closest('label'), box = input.nextElementSibling
      const r = row.getBoundingClientRect(), css = getComputedStyle(box)
      input.focus()
      return { '复用统一复选框样式': css.width === '18px' && css.height === '18px' && getComputedStyle(row).display === 'flex',
        '文字没有横向溢出': r.left >= 0 && r.right <= innerWidth && row.scrollWidth <= row.clientWidth + 1,
        '可使用键盘聚焦': document.activeElement === input }`)
    if (process.env.E2E_SCREENSHOT_DIR) {
      const shot = await b.send('Page.captureScreenshot', { format:'png' })
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR, name + '-checkbox.png'), Buffer.from(shot.data, 'base64'))
    }
    await b.send('Input.dispatchKeyEvent', { type:'keyDown', key:' ', code:'Space', windowsVirtualKeyCode:32 })
    await b.send('Input.dispatchKeyEvent', { type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32 })
    await step(name + ' 空格切换偏好', `const input = __top().querySelector('#ualrisk')
      const saved = input.checked && localStorage.getItem('cfsub-local-risk-v1') === '1'
      input.click(); await __close(); return saved && localStorage.getItem('cfsub-local-risk-v1') === null`)
  }

  sec('JSON 菜单与弹窗：手机和桌面布局')
  for (const [name, opt] of [['desktop-light', { w:1100, h:900 }], ['mobile-dark', { w:390, h:844, mobile:true, dark:true }]]) {
    await page('node', opt)
    const pos = await b.run(`document.querySelector('#ownadd').scrollIntoView({block:'center'}); const r=document.querySelector('#ownadd').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`)
    if (opt.mobile) {
      await b.send('Emulation.setTouchEmulationEnabled', { enabled:true })
      await b.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[pos] })
      await b.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] })
    } else {
      await b.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...pos})
    }
    await step(name + ' 添加菜单', `const menu=document.querySelector('#ownaddmenu'), r=menu.getBoundingClientRect()
      return { '实际触摸或悬停展开': !menu.hidden, '菜单不超出左右边界': r.left>=0 && r.right<=innerWidth+1,
        '菜单只有一个触发按钮': document.querySelectorAll('.own-add > button').length===1 }`)
    if (process.env.E2E_SCREENSHOT_DIR) {
      const shot = await b.send('Page.captureScreenshot', {format:'png'})
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR, name + '-add-menu.png'), Buffer.from(shot.data,'base64'))
    }
    await step(name + ' JSON 导入布局', `document.querySelector('#ownaddmenu button:last-child').click()
      await __until(__top); const box=__top(), ct=box.querySelector('.ct'), r=box.getBoundingClientRect()
      await __until(()=>!document.querySelector('.bd.out'))
      return { '输入示例不成为表单内容': box.querySelector('#ownjsontext').value==='',
        '弹窗和文本框没有横向溢出': r.left>=0 && r.right<=innerWidth+1 && ct.scrollWidth<=ct.clientWidth+1,
        '三种结构说明齐全': box.querySelectorAll('#ownjsonexamples details').length===3 }`)
    if (process.env.E2E_SCREENSHOT_DIR) {
      const shot=await b.send('Page.captureScreenshot',{format:'png'})
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR,name+'-json-import.png'),Buffer.from(shot.data,'base64'))
    }
    await step(name+' 证书风险告知布局',`const parent=__top();window.__riskLayout=acknowledgeInsecure(parent,[{insecure:true}])
      const warning=await __until(()=>__top()!==parent&&__top());await __until(()=>warning.contains(document.activeElement))
      const r=warning.getBoundingClientRect();return {'告知窗口不超出视口':r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,
        '只显示已了解按钮':warning.querySelectorAll('button').length===1&&warning.querySelector('button').textContent==='已了解'}`)
    if(process.env.E2E_SCREENSHOT_DIR){
      const shot=await b.send('Page.captureScreenshot',{format:'png'})
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR,name+'-insecure-warning.png'),Buffer.from(shot.data,'base64'))
    }
    await b.run(`__top().querySelector('[data-ok]').click();await window.__riskLayout`)
    await b.run(`await __close()`)
    if (opt.mobile) await b.send('Emulation.setTouchEmulationEnabled', {enabled:false})
  }

  sec('页面错误')
  ok(b.errors.length === 0, '整个过程没有未捕获的异常或 console.error', b.errors.slice(0, 3).join(' | '))
} catch (e) {
  ok(false, '测试过程出错', e.message)
} finally {
  b.close()
  fs.rmSync(path.dirname(OUT), { recursive: true, force: true })
}

console.log(`\n${'='.repeat(46)}\n端到端 通过 ${pass} · 失败 ${fail}\n${'='.repeat(46)}`)
process.exit(fail ? 1 : 0)
