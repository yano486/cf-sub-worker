# cf-sub-worker

本仓库基于 [kittors/cf-sub-worker](https://github.com/kittors/cf-sub-worker)，保留原有聚合与分流功能，增加五协议可视化编辑、浏览器本地网络拉取、表单样式统一和安全加固。

相比原版，主要增加了可在线编辑vless、hy2、ss、vmess、anytls功能，并支持json批量导入，对自建节点编辑相对友好


## 部署

需要一个 Cloudflare 账号，API token 授予 **Workers Scripts: Edit** 和 **Workers KV Storage: Edit** 两项权限。

```bash
git clone https://github.com/yano486/cf-sub-worker.git
cd cf-sub-worker

export CF_API_TOKEN=...      # My Profile → API Tokens
export CF_ACCOUNT_ID=...     # 控制台右侧栏
bash deploy.sh
```

脚本会自动创建 KV namespace、注入绑定、部署，并打印一个**初始化令牌**。到 Cloudflare 控制台给 Worker 绑一个域名，打开 `https://你的域名/admin`，用该令牌验证身份并设置管理密码。

部署后，直接打开 `https://你的域名/` 也会进入管理端。建议使用 Cloudflare Workers **自定义域名**绑定，由 Cloudflare 管理对应 DNS 与 HTTPS；不要为了绑定子域名而覆盖根域已有记录。

如果只保留自定义域名入口，可以在 Worker 的域名设置中关闭该 Worker 的 `workers.dev` 和预览地址。先把客户端中的旧订阅地址换成新域名，再关闭旧入口；后续部署后也应核对这些开关。这里只需关闭单个 Worker，不要关闭账号的整个 `workers.dev` 子域。

以上功能不要求开通 Workers 付费套餐或付费 WAF，但正常访问、KV 读写和存储仍占用对应套餐额度。本地下载使用浏览器当前网络，上传快照与访问本站仍经过 Cloudflare；不是“完全不消耗 Cloudflare 流量”。免费额度与限制以 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)及 [KV 定价](https://developers.cloudflare.com/kv/platform/pricing/)为准。

再次部署（更新代码）时，脚本沿用 Worker 现有的 KV 绑定与全部 secret / 变量，部署前会先跑测试，部署后逐个核对绑定一个不少。几个常用开关：

```bash
DRY_RUN=1 bash deploy.sh              # 只核对：打印将要提交的绑定，不真的部署
SKIP_TESTS=1 bash deploy.sh           # 跳过部署前的测试
KV_NAMESPACE_ID=... bash deploy.sh    # 明确指定 KV namespace
```

读取 Worker 现有设置失败（网络抖动、限流）时脚本会直接中止 —— 绝不把线上绑定当成空的覆盖掉。

之后管理端的「节点」页会给出上手清单，依次完成：

1. **设置 → 站点** — 填本站域名（用于 DNS 策略与自身直连规则）
2. **节点** — 添加机场订阅源；有自建节点就一并添加（支持 VLESS、Hysteria2、Shadowsocks、VMess 与 AnyTLS，可粘贴分享链接自动填表）
3. **订阅** — 默认已有一份，选好客户端后复制地址、扫码或一键导入；给不同设备可再建几份

## 订阅源更新方式

添加和编辑订阅源使用相同的三项选项。修改某一个源的更新方式，不会迁移其他源的配置。

| 更新方式 | 谁请求上游 | 更新时机 |
|----------|------------|----------|
| 自动更新 | Cloudflare Worker | 添加或更换链接时试拉；后续请求按约 1 小时的新鲜期刷新缓存，不是独立的定时任务 |
| 手动快照 | 初次添加或更换链接时由 Worker 试拉，也可手动粘贴 | 已有快照时不参与自动拉取；没有快照时仍可能尝试请求上游 |
| 使用本地网络拉取 | 你的浏览器，使用其当前网络或代理 | 添加、切换为本地模式、更换链接或点击源旁的本地更新按钮时下载；只修改名称不下载 |

本地模式下，Worker 只使用已保存的快照。没有快照、点击全局刷新、查看诊断或本地下载失败，都不会偷偷改用 Cloudflare 请求上游。页面关闭后不继续更新；要更新该源，重新打开管理页并点击源旁的“使用本地网络拉取”。

### 使用本地网络拉取

1. 打开“添加订阅源”，或编辑已有订阅源，填写名称和 HTTPS 订阅链接。
2. 将“更新方式”选为“使用本地网络拉取”，点击添加或保存。
3. 允许本站打开临时拉取窗口。浏览器下载成功后，内容交回管理页，通过 HTTPS 上传本站并保存为快照。
4. 源旁出现“本地”标记和单独的更新按钮。全局刷新只沿用此源的快照，不发起本地下载。

切换到“使用本地网络拉取”时，会先出现站内风险确认框，说明出口 IP、敏感凭据及 Cloudflare KV 保存边界。点击“确定”才切换方式；取消保留原选择，不发起下载。

选中本地方式后，下方会显示“已了解风险，不再弹出提示”。默认不勾选，每次选择本地方式都会提醒；勾选后仅在当前浏览器、当前站点记住，取消勾选可恢复提醒。该偏好不写入 KV，也不随备份同步；清除站点数据或换浏览器后会重新提示。

如果已经在文本框粘贴了订阅内容，会直接解析文本，不重复请求上游。本地模式保持不变；其他方式的粘贴导入会转为手动快照。

本地模式的跨域限制、下载上限与隐私边界见[进阶配置 / 平台说明](#进阶配置--平台说明)。

## 客户端

在「订阅」页顶部选客户端，下面每份订阅的地址、二维码、一键导入都会跟着切换。

| 客户端 | 选哪个 | 说明 |
|--------|--------|------|
| Clash Verge Rev / Mihomo Party / FlClash / Stash / Clash Meta for Android | Clash | 下发 mihomo 内核的 Clash YAML |
| Shadowrocket | Shadowrocket | 地址带 `&fmt=shadowrocket`，下发原生 `.conf`；iPhone 用相机扫「一键导入」二维码可直接唤起 |
| sing-box 官方客户端（SFI / SFA / SFM） | sing-box | 地址带 `&fmt=singbox`，需要 sing-box **1.12 及以上** |
| v2rayN / v2rayNG / Hiddify 等 | 通用 | 地址带 `&fmt=share`，base64 节点列表，**不含分流规则**，也不含链式代理 |

不加参数时按 User-Agent 猜格式（认不出就给 Clash YAML）。其它参数：`&mode=blacklist` 切黑名单模式（没命中规则的直连），`&upstream=0` 应急只下发自有节点。

订阅响应带 `Subscription-Userinfo` 头：这份订阅所含机场的流量相加、到期取最早的一家，客户端里能直接看到剩余流量和到期日。一家都拿不到用量时不发这个头，不编数字。

自有节点的高级字段与客户端格式兼容说明见[进阶配置 / 平台说明](#进阶配置--平台说明)。

### JSON 编辑与批量导入

自有节点右上角使用同一个“添加 ▾”按钮：电脑支持鼠标悬停或点击展开，手机点击展开，可选“手动添加”或“批量导入 JSON”。添加、编辑单个节点时，弹窗左下角的“编辑 JSON”会加载当前表单草稿；解析后只填回表单，仍需点击“保存”才会写入。

自动识别编辑器 JSON 对象 / 数组、Clash / Mihomo JSON 或常见 YAML、Xray 与 sing-box 出站节点、`outbounds` / `proxies` 片段及完整配置。无需补齐完整外壳；结构末尾的多余逗号会安全处理，字符串里的逗号不改动。输入框上方按格式列出 SS、VLESS、VMess、HY2、AnyTLS 的只读结构示例，仅展示对应内核真实支持的组合。完整配置只提取节点，不导入路由、DNS 或入站设置。批量导入只新增节点，不覆盖现有节点；重名会提示修改，不会自动替换。

每批最多 100 个节点、256 KiB UTF-8、16 层嵌套。解析和预览在浏览器本地进行，不请求上游；批量保存沿用节点保存接口，一批写入一次 `nodes`，不是每个节点各写一次。保存和界面刷新仍占用正常的 Worker 请求与 KV 读写额度，不需要付费功能。

基础字段映射到当前五协议编辑器，已识别的 ECH、Xray `finalmask` 和 sing-box TLS 分片字段原样保存在“客户端专用参数”中。sing-box 分片参数会随 sing-box 完整配置下发；不能等效表达这些参数的输出格式会提示并剔除整条节点及其分组引用，而不是去掉参数后强行连接。未知或不支持的连接字段仍按节点序号和原始路径报错，整批不保存。已关闭的复用、导出器冗余默认字段，以及非代理出站会明确列为未导入项。

Clash YAML 使用本地安全子集解析器，支持常见流式 / 块式节点、嵌套、引号和注释；多个单行节点可一起粘贴，兼容列表整体缩进和复制时首行缩进缺失。不支持标签、锚点、别名、合并、多文档及多行标量。不会执行输入内容，也不调用第三方转换服务。

图形编辑中，每次勾选开启“跳过证书校验”就立即弹出站内风险告知，说明可能遭受中间人攻击；仅有“已了解”按钮。取消勾选不提醒，再次勾选会再次提醒，同一草稿确认后保存不重复弹窗。JSON 或分享链接解析填回时若启用了跳过校验也会告知；批量导入在确认保存前统一提示一次。没有“不再提示”选项。

客户端专用参数无需删除才能复制节点：复制按钮会在必要时提供“复制基础链接”确认，说明通用 URI 无法携带的分片、旧版 ECH 查询策略等选项可能影响连接或隐私。确认后只复制基础配置，原节点的完整参数仍保留。订阅输出仍按格式兼容性处理，不会自动改成缺少专用参数的订阅。显式关闭的分片标志、空 ECH 和空 finalmask 列表等不生效默认值不再生成专用参数块；现有节点不会自动迁移。

VLESS 分享链接中的 ECH 使用 v2rayN 支持的 `ech=` 参数。JSON 导入的 `tlsSettings.echConfigList` 会作为完整字符串编码一次后放入该参数，固定配置与 DNS 查询字符串都保留；“复制基础链接”也不会丢掉可以表达的 ECH。与分享链接导入的 `ech` 内容一致时只输出一份，若两处值冲突则明确报错，不静默覆盖。旧版 `echForceQuery` 策略和 `finalmask` 仍没有已验证的等价 URI 表达，会单独提示，不代表整个链接已无损转换。

Clash Reality 的 `reality-opts.support-x25519mlkem768` 支持布尔值导入、编辑与再次导出，缺省记录不自动补值。图形表单提供“客户端默认 / 允许指纹提供该能力 / 移除该能力兼容旧服务端”三态。它是 Mihomo 的指纹密钥交换能力开关，不是强制启用后量子，也不是 Xray 的 `mldsa65Verify` 签名验证参数。分享链接保留标准 Reality 公钥、ShortId、SNI、指纹与 Flow；Xray 等目标内核自行协商，不能保证该 Mihomo 开关跨内核、跨版本完全等效。

### 基础兼容输出

节点编辑的“高级配置”中，带客户端专用参数的节点可选择“基础兼容输出”。默认关闭：无法完整转换的格式仍不下发该节点。开启前会说明可能省略的参数、连接与隐私影响，确认后才启用；这项选择影响包含该节点的所有订阅，而不只是当前设备。

开启后，仅省略当前格式不能表达的 ECH、`finalmask` 或 TLS 分片等专用设置，其余基础节点仍正常下发；证书校验、VLESS Encryption 和传输支持范围等其他限制不变。完整原参数保存在节点中，关闭即可恢复严格输出。不会自动修改已有节点，也不会自动为导入的外部配置开启。节点 JSON 使用 `compatibilityMode: "basic"` 或 `"strict"` 表示该选择；导入显式 `basic` 的 JSON 时仍需在界面确认。

可准确转换的固定 ECHConfigList 会直接映射到 Clash / Mihomo 的 `ech-opts` 和兼容的 sing-box `tls.ech`，无需开启基础兼容模式。Xray 指定 DNS 解析器的动态 ECH、非空 `echForceQuery` 及 `finalmask` 等尚无等价映射的配置不会假装无损转换。管理页会合并相同格式警告，订阅预览仍按实际输出列出省略项。

## 安全

管理端开在公网上，订阅 token 持有者可以取得该配置视图中下发的节点凭据，因此需要保护以下信息：

- **管理密码** PBKDF2 加盐存储（老版本的无盐哈希在下次登录时自动升级）；同一 IP（IPv6 按 /64）连续输错 5 次锁定 15 分钟，改密码时猜旧密码同样计数。计数放在内存与 Cache API 里、不写 KV —— 否则谁都能不登录就刷光每天的 KV 写入额度
- **会话** cookie 为 `HttpOnly` / `Secure` / `SameSite=Lax`，写接口另外核对来源并只收 JSON，降低跨站请求伪造风险；改密码或“让其它设备下线”会轮换会话密钥，旧会话在存储同步后失效
- **管理端页面**带 CSP、禁止被嵌套、不发 Referer；机场送来的节点名、机场名在管理端一律转义 —— 它们是第三方可控的输入
- **HTTPS**：非本机 HTTP 页面请求跳转 HTTPS，HTTP 写操作直接拒绝；HTTPS 响应带 HSTS。节点与订阅地址应始终使用 HTTPS，跳转无法追回已经发到 HTTP 链路的内容。
- **存储故障**：密码、会话密钥和订阅权限读取失败时返回暂时不可用，不重新初始化、不恢复默认授权、不覆盖已有密钥。
- **抓取诊断**只显示状态、格式、数量和解析后的用量信息，不回显订阅原文、原始公告、远端错误正文或任意响应头；二维码、订阅地址与备份仍需保密。
- **订阅 token** 至少 16 位，定长比较；订阅页记录每份订阅最近被哪些客户端拉过（IP、客户端、时间），出现不认识的就重新生成 token
- **备份文件**包含全部配置和节点凭据（不含登录密码），请妥善保管

这些措施不等于“绝对不会泄露”。浏览器扩展、电脑、Cloudflare 账号权限、客户端保存的配置以及人为外发链接，仍属于需要你自己保护的范围。站点导出的备份是明文 JSON，不应提交到 GitHub。

## 进阶配置 / 平台说明

以下为较长的配置与实现说明，按需展开。

<details>
<summary><b>自有节点编辑与协议兼容</b></summary>

添加或编辑自有节点时，基础字段按协议切换，高级字段收在「高级配置」中：

成对字段使用对齐的网格布局，窄屏自动改为上下排列；勾选项统一使用站点主题色，保留键盘空格操作、焦点反馈和文字点击切换。

- **VLESS**：TLS / Reality、Flow、Encryption、TCP / WS / HTTPUpgrade / gRPC / H2 / XHTTP、路径、Host、ServiceName、指纹、ALPN 与 UDP 包编码。
- **Hysteria2**：完整认证密码（可含 `username:password`）、SNI、ALPN、证书校验、Salamander、端口跳跃、跳跃间隔和带宽。QUIC 不使用 TCP uTLS 指纹；实验性 Gecko / Realm 未混入当前兼容模式。
- **Shadowsocks**：加密方式（含 SS2022）、密码 / 密钥、UDP-over-TCP、simple-obfs / v2ray-plugin 的可视化参数。SS2022 密钥会检查 Base64 和长度。
- **VMess**：UUID、加密方式、AlterID、TLS、传输、WS 请求头与 Early Data。
- **AnyTLS**：密码、TLS、SNI、ALPN、指纹和空闲会话池参数。

字段在保存、重新打开和支持该字段的订阅格式中保持一致。VMess 按 [v2rayN 官方分享格式](https://github.com/2dust/v2rayN/wiki/Description-of-VMess-share-link)识别 `insecure`、`vcn`、`pcs`；AnyTLS 省略端口时使用官方默认的 443。未知附加字段不再阻断整条链接，会保留在「导入扩展字段」中、随保存和再次编辑保留，并在完整配置兼容提示中列出。原始分享链接导出保留这些扩展参数；尚未实现的连接参数不代表已生效，请按提示选择适合的客户端。无效必填字段、非法安全模式和不完整认证仍会明确报错，不会靠默认选项悄悄改写。旧 VLESS / Hysteria2 记录不在读取或保存其他节点时迁移；原有节点标识和订阅 token 不变。

VLESS 的协议加密字段是 `encryption`，VMess 的加密方式来自 `scy`，均与传输路径分开保存。WebSocket 路径缺少前导 `/` 时，按 Xray 的规则补齐；路径内已有的百分号编码不做二次解码。

已知限制：Xray WebSocket 路径中的 `?ed=数字` 会拆成独立的 Early Data 字段保存，Clash / sing-box 完整配置仍会携带；当前通用分享链接不会把它还原成路径里的 `?ed=`。这通常影响首包提前发送优化，不代表 ECH 或其他路径参数应被删除，也不保证所有客户端行为一致。

证书校验域名 `vcn` 和完整证书 SHA256 指纹 `pcs` / `pinSHA256` 可在高级配置中编辑，并映射到 Clash 的 `name-cert-verify` / `fingerprint`。完整证书指纹不能当成公钥指纹；兼容的 sing-box 1.12–1.14 无法表达时会提示并剔除该节点，而不是去掉证书校验强行连接。

不同客户端不是同一套协议能力：XHTTP、VLESS Encryption、SS 插件及某些高级调优项不能用所有格式表达。「自有节点」下方及订阅预览会列出具体兼容提示，不能忠实转换的节点会从该格式和分组引用中一起剔除。通用 URI 不携带 UDP 开关、任意请求头或 AnyTLS 会话池等客户端专属设置；需要这些参数时使用 Clash / sing-box 完整配置。

字段依据：[Project X](https://xtls.github.io/config/outbounds/vless.html)、[Hysteria](https://v2.hysteria.network/docs/advanced/Full-Client-Config/)、[Shadowsocks SIP002](https://shadowsocks.org/doc/sip002.html)、[AnyTLS](https://github.com/anytls/anytls-go/blob/main/docs/protocol.md)、[Mihomo](https://wiki.metacubex.one/config/proxies/) 与 [sing-box](https://sing-box.sagernet.org/configuration/outbound/)。

</details>

<details>
<summary><b>本地模式的限制与隐私边界</b></summary>

- **需要 CORS**：浏览器能在新标签页打开链接，不代表管理页能读取它。上游必须允许管理页来源跨域访问；这里无法替上游解除浏览器限制。
- **不携带登录 Cookie**：下载使用 `credentials: 'omit'`，不发送 Referer，也不跟随重定向。请使用提供方的最终 HTTPS 订阅地址；依赖网页登录态、验证码或跳转的链接可能无法读取。
- **下载有上限**：最长 20 秒、内容最多 2MB。父页面最多等待 30 秒，窗口被拦截、关闭或超时会提示失败，不转交 Worker 拉取。
- **用量头可能不可读**：`Subscription-Userinfo` 需要上游通过 `Access-Control-Expose-Headers` 暴露；否则只能尝试从订阅内容里的公告解析用量。
- **不放宽整个后台的外连策略**：主页面继续限制同源连接；已登录用户的临时窗口只允许连接所选订阅站点。完整订阅链接不放进临时窗口地址，下载结果只传回同源管理页。
- **保存不等于本地保密**：下载结果和上游链接最终存入你自己的 Cloudflare KV，供订阅聚合使用。链接、节点、二维码与备份仍然是敏感数据，不要公开分享诊断原文或交给陌生中转服务。
- **保存成功后才提示成功**：本地快照写入失败时不新增或更改源；若发现其他页面已更换链接或模式，旧下载结果会被拒绝。KV 是最终一致存储，这不是跨区域强事务保证，避免同时在多处编辑同一源。

如果上游不支持 CORS，可以回到已有的粘贴导入方式：用自己的浏览器打开订阅链接，复制原始 Base64、YAML 或分享链接列表后粘贴；不要复制登录页、验证码页或错误页 HTML。

</details>

<details>
<summary><b>分流策略与链式代理</b></summary>

策略是有序的，**命中即停止匹配**，所以更具体的要排在更宽泛的前面 —— 比如 `📺 YouTube` 必须在含 `googleapis.com` 的 AI 策略之前，否则 `youtubei.googleapis.com` 会被 AI 规则抢走。默认顺序已排好，拖拽时留意；拿不准的时候，用页面下方的「规则测试」输一个网址看看。

每条策略可配：

- **分流目标** — 自有节点 / 链式代理 / 机场地区组 / 全部节点 / 直连 / 拒绝，**可多选**：选多个时都放进策略组，第一个是默认项
- **严格模式** — 组内只放目标本身，目标不可用即断流。AI 类建议开启：静默回落会让出口悄悄变成机房 IP，比断流更难察觉
- **引用域名集** — 从 13 组内置域名库里选，也可新建；改一处，所有引用它的策略同步生效
- **额外域名 / 关键词 / 进程名** — 策略私有的补充规则

每份订阅的策略可以是「继承全局」或「专属」。专属模式下持有一份完整副本，目标、域名、顺序都与全局无关 —— 典型用法是全局 AI 走美西住宅出口，手机订阅的同名策略改指日本节点。

某份订阅不含严格策略指向的自建节点时（比如给家人的订阅不带自建节点），那组会回落到「🚀 节点选择」，出口变成机场节点 —— 订阅卡片上会点名提示是哪几条。

**链式代理有单独的配置边界。** 当前链式节点使用全局定义，可以引用订阅直接列表之外的机场落地节点。不要把“在订阅中排除一个机场”理解为其落地凭据绝不会通过全局链出现；需要严格按人隔离节点时，应同时核对链式配置。

</details>

<details>
<summary><b>机场用量与到期识别</b></summary>

流量与到期优先读 `Subscription-Userinfo` 响应头，缺失时从节点名里的公告文本兜底解析。已覆盖的写法：

- 日期 `2026-08-10` / `2026/08/10` / `2026年8月10日`
- 流量 `剩余流量：809.16 GB` / `剩余: 100GB` / `Remaining: 50 GB` / `已用 390.8GB` / `390.8GB/1200GB`
- 天数 `距离下次重置剩余：7 天`（不会误判为到期）/ `剩余 30 天`
- 单位 GB/TB/MB、简写 G/T、GiB 均按二进制换算；时间戳秒与毫秒自动归一

解析不到就留空，不猜。公告识别做了精确匹配，`香港原生IP-1|勿跑大流量` 这类含「流量」二字的正常节点名不会被误吞。点订阅源行上的用量，可以查看状态、格式、节点数量等诊断信息；本地模式的诊断不从 Worker 请求上游。

</details>

<details>
<summary><b>Workers KV 数据结构</b></summary>

全部存 Workers KV（绑定名 `CONF`）。**代码里不含任何站点信息**，clone 下来就是干净的。

| key | 内容 |
|-----|------|
| `settings` | 本站域名、额外直连域名与 IP、强制代理域名、DNS |
| `nodes` | 自有节点 |
| `upstreams` | 机场订阅源及更新方式；新增方式写入 `updateMode`，旧记录继续按 `auto` 解释，不在读取时迁移 |
| `overrides` | 节点级重命名 / 停用 |
| `profiles` | 订阅档案，一个 token 一份；`policies` 为 `'inherit'` 或专属策略数组 |
| `policies` | 全局分流策略，数组顺序即优先级 |
| `lib` | 自定义 / 改过的域名集，与内置 `PRESETS` 合并 |
| `chains` | 链式代理 |
| `cache:nodes` | 机场拉取缓存，1 小时新鲜期，7 天兜底 |
| `snap:<源 id>` | 每个订阅源最后一次成功拉取的快照 |
| `hits:<订阅 id>` | 最近拉取这份订阅的客户端（每客户端半小时记一次，每天最多写 60 次） |
| `auth:password` / `auth:secret` | 管理端凭据 |

各 `DEFAULT_*` 常量只是首次初始化的种子，KV 有值就以 KV 为准。「设置 → 备份与恢复」导出的就是上表前八项加快照。

</details>

<details>
<summary><b>本地开发与测试</b></summary>

```bash
node dev/server.mjs                             # 本地预览 http://localhost:8787/admin，密码 devpassword
npm install --prefix test && node test/run.cjs  # 单元与接口测试
node --test test/own-protocols.cjs              # 自有节点多协议保存、导入、输出与兼容回归
node --test test/own-json.cjs                   # 本站 / Clash / Xray JSON 识别与安全边界回归
node --test test/adaptive-import.cjs test/client-options.cjs # 配置片段、Clash YAML、sing-box 与专用参数回归
node --test test/yaml-multi.cjs                 # 多节点单行 YAML 缩进与安全边界回归
node --test test/compatibility-mode.cjs test/ech-mapping.cjs # 兼容模式、ECH 映射及保密边界回归
node --test test/ech-share.cjs                  # VLESS ECH 双导入路径、编码与只读分享回归
node --test test/reality-pq.cjs                 # Reality 能力开关、三态及跨格式身份保留回归
node --test test/import-compatibility.cjs       # 官方分享链接字段与扩展参数导入回归
node --test test/encryption-path.cjs            # 加密字段、路径编码与 WebSocket 路径归一回归
node --test test/security-hardening.cjs         # HTTPS、权威状态故障关闭与诊断最小输出回归
node --test test/local-network.cjs              # 本地模式、CSP、快照写入、冲突与浏览器消息流程回归
node test/e2e.mjs                               # 端到端：在无头 Chrome 里把管理端完整点一遍（需本机有 Chrome）
node scripts/build-demo.mjs                     # 重新生成 docs/demo.html
node scripts/shots.mjs                          # 重新生成 README 截图
bash deploy.sh                                  # 部署
```

`worker.js` 单文件承载全部逻辑 —— Workers 部署一个 JS 文件最省事，也免去打包步骤。改完先跑测试再部署。

本地预览在 Node 里直接执行 `worker.js`，不需要 wrangler：KV 落盘到 `dev/.kv.json`（删掉即回到示例数据），自带两个示例机场和一个模拟被拦截的机场，改完 `worker.js` 刷新页面即生效。

本机开发页面允许使用 localhost 或 `127.0.0.1` 的 HTTP 测试订阅，线上部署仍要求 HTTPS。本地模式回归使用虚构内容和替代网络函数，不需要真实订阅。现有浏览器端到端测试需要 Chrome；没有实际执行时，不应把语法检查或离线测试写成端到端通过。

GitHub Actions 运行单元与接口测试、协议 / JSON / 安全 / 本地网络回归、已有浏览器端到端测试，并检查 `docs/demo.html` 与源码同步。README 中的截图不是每次代码更新都自动重拍。

管理端前端整个嵌在 `adminHTML()` 的模板字符串里：前端代码里的反斜杠、反引号、`${` 都要转义（`\\n`、`` \` ``、`\${`），写成单个反斜杠会被模板提前吃掉 —— `run.cjs` 会实际编译前端脚本和其中的正则来把关。

测试覆盖三种输出格式的合法性与引用完整性、三种入站格式的等价性、规则优先级、目标解析回退、机场元信息多格式解析、多订阅裁剪、粘贴导入、认证与会话、备份恢复、规则测试，以及一组管理端 UI 的静态断言；端到端测试把每个页面、每种弹窗和主要的增删改真的点一遍，页面里出现任何未捕获的异常都算失败。

</details>

## License

MIT
