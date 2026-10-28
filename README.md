# dsh-python-only

> GitHub：https://github.com/yinghan-123/dsh-python-only · 一行安装：`pnpm add github.com/yinghan-123/dsh-python-only`

强制 DeepSeek Harness（DSH）的 Agent **一切代码执行与数据处理都使用 `python` 工具**，并用工具守卫**拦截 shell 类工具**。为 DSHM 端侧（HarmonyOS 手机 / 平板 / PC）设计：端侧 `python` 工具跑在宿主进程内的内嵌 CPython 3.12（不 execve、不依赖 guest VM），而 `bash` 走 guest 虚拟机、guest 里没有 python3。

**1.1.0 起是双向的**：不只是"开着时强制"，**关掉之后也会每步告诉模型约束已经解除**——不然模型会一直照着过期提示词继续绕开 shell。

## 它做什么

三层，各司其职：

| 层 | 机制 | 效果 |
| --- | --- | --- |
| 提示词 | `systemPrompt.section`（`app:python-only`）+ 每步动态提醒（`app:python-only-reminder`） | 按**当前状态**输出：强制中给规则；关闭后给"已关闭"通知 |
| 守卫 | `tools.guard()` 同步拦截 | 模型若仍调用 `bash` / `pwsh` / `terminal_*`，调用被**直接拒绝**（结果 `Error: …`），文案指向改用 `python` |
| 状态通知行 | 同包第二行 `python-only-notice`（`name: dsh-python-only/notice`） | 主插件被「插件守卫」停用后，代它每步告诉模型"约束已解除" |

守卫是单调的：一旦拒绝，没有任何插件能重新放行该次调用。

## 关闭后会发生什么

| 怎么关的 | 谁在说 | 模型下一轮看到 |
| --- | --- | --- |
| 设置页关掉总开关（`enabled: false`） | 主插件（还活着） | 「python-only 已关闭（设置页的总开关已关闭）——`bash`/`pwsh`/`terminal_*` 现可直接调用…此前'必须用 python'是旧状态，以本条为准」 |
| 拦截列表清空（`blockedTools: []`） | 主插件 | 同上，原因换成「拦截列表为空（没有配置任何要拦截的工具）」 |
| 「插件守卫」里停用 `python-only` 行 | 常驻通知行 `python-only-notice` | 「`python-only` 插件**现已停用**——工具守卫不再拦截任何工具…需要恢复：在插件守卫里重新启用」 |
| 把包卸载 | 没有人 | 两行一起消失，**发不出通知**（历史消息里的旧提示仍在，这是本插件的能力边界） |

实现要点：

- 提示词的 `text` 都是**函数**，DSH 每步装配 / 每次模型调用前都会重算，所以三种状态的切换都是热的，不需要重启；
- 文案里固定带一句「此前的提示是旧状态，以本条为准」——运行时上下文是**追加**到对话里的，旧消息删不掉，只能靠新快照（DSH 会加 "supersedes earlier runtime-context snapshots" 头）压过去；
- 通知行读的是 `lib/state.js` 的**进程内状态位**（`globalThis` + `Symbol.for`），主插件活着时它保持沉默，避免同一句话说两遍。

## 设置界面

**设置 → 侧栏「强制 Python」**（客户端半部 `lib/client.js` 注册 `settings.section`，order 26）。
页面内容：

| 控件 | 作用 |
| --- | --- |
| 开关 | 总开关；关闭后提示词改说「已关闭」、不再拦截工具（**立即生效**） |
| 拦截工具列表 | 逗号/换行分隔的工具名，默认 `bash`、`pwsh`、`terminal_open/send/read/signal/close/list`；清空 = 不拦截 |
| 保存 / 恢复默认 | 写入 profile 行并**立即生效** |

实现要点：

- **为什么需要客户端半部**：DSH 的「设置 → 插件」页只渲染**官方插件**的 companion 配置页；第三方 bundle 的配置页必须由包自己的浏览器 bundle 注册到 slot。本插件注册一个独立设置页，不依赖任何官方 UI 包的其他接口。
- **数据通道**全部走平台公开面：`ctx.configForms.get("python-only")` 拿表单 scope，`getSnapshot()/subscribe()` 读、`set()/unset()` 写。
- **热生效**：host 半部的 `Config` 字段都标了 `volatile()`，写入经 settings 服务落回 profile 行、再由 cosmokit 的 volatile 引用原地更新运行中的实例 —— 设置页保存后无需重启。
- 平台模块（`react`、primitives）全部 optional，缺 React 时退化为 inert 渲染而不是拖垮设置面板。

> 也可以直接写 profile 行的 `config`（见下节），两种方式等价。

## 不做什么

- **不提供** python 工具本身。端侧由 `@deepseek-ai/dshm-tool-python` 提供；桌面端由 DSH 自带的 python 工具提供。
- 不拦 `read` / `glob` / `grep` / `web_fetch` / `web_search` / 子代理等非执行类工具。
- 没有命令白名单：`git`、`pnpm`、构建命令同样被拦（刻意选择——端侧 bash 不可靠，与其半开不如全关）。
- 不删除历史消息：关闭通知只能"覆盖"旧提示的语义，删不掉已经写进会话的那几句。
- 卸载包之后无法通知模型（连通知行一起没了）。
- 不写持久化状态：配置就是 profile 行里的 `config`。

## 安装（DSHM 端侧）

**一行安装** —— DSHM 端侧 PATH 里的 `pnpm` 是 Host 布置的假壳，`add` 会被改写成安装队列、由进程内安装器（`dshm-installer.js`）完成并同步返回结果：

```bash
pnpm add github.com/yinghan-123/dsh-python-only
```

装完 **重启 DSHM** 一次才会挂载（profile 的 `patchReload` 是 `startup`）。需要手动部署、或要精确控制文件落位时，用下面的方式 —— 三个位置都要就位：

1. **包**：把本目录整体复制到 profile 的 `node_modules`：

   ```text
   <DSH_HOME>/profiles/ondevice/node_modules/dsh-python-only/
   ```

   （`DSH_HOME` 本机是 `/data/storage/el2/base/haps/entry/files/dsh/home`。）

2. **bundle 声明**：`profiles/ondevice/package.json` 里

   ```json
   "dependencies": { "dsh-python-only": "1.1.0" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-python-only" ] } }
   ```

   （两行由包自带的 `cordis.patch.yml` 插入，不依赖会被种子重建的 `dshm-user-rows` 用户区。）

3. **配置覆盖行**（可选，只影响初始值）：`profiles/ondevice/cordis.patch.yml` 里给主行写 `config`：

   ```yaml
   - id: python-only
     name: dsh-python-only
     config:
       enabled: true
       blockedTools:
         - bash
         - pwsh
         - terminal_open
         - terminal_send
         - terminal_read
         - terminal_signal
         - terminal_close
         - terminal_list
   ```

   若手工加行（不走 bundle patch），**两行都要加**：

   ```yaml
   - id: python-only
     name: dsh-python-only
   - id: python-only-notice
     name: dsh-python-only/notice
   ```

4. **重启 DSHM** 一次（profile 的 `patchReload` 是 `startup`；客户端 bundle 也只在启动时被 `dsh-client-modules` 扫描）。

## 停用 / 回滚

- **临时放行 shell 并通知模型**：设置页关掉开关（立即生效，下一轮提示词就变成"已关闭"）。
- **完全停用**：`package.json` 的 bundles 里去掉 `dsh-python-only`（或给**两行**都加 `disabled: true`），重启。
  只停主行会保留通知行 —— 模型仍会被告知"已停用"，这是特性不是 bug。
- **彻底移除**：删 `node_modules/dsh-python-only/`、bundles/dependencies 条目与那行 config，重启。

## 验证清单

1. 设置侧栏出现「强制 Python」页，开关与列表可编辑，保存后立即生效。
2. Agent 调 `bash` → 返回 `Error: 本环境强制使用 python 工具：\`bash\` 已被 python-only 插件禁用…`。
3. Agent 用 `python` 跑代码 → 正常返回。
4. 系统提示里出现「# 强制 Python 工具（python-only）」段。
5. **关掉开关后**：下一轮模型调用带「python-only 已关闭（设置页的总开关已关闭）…」提醒，`bash` 能真的执行；重新打开后恢复拦截与强制文案。
6. **在插件守卫里停用 `python-only` 行后**：下一轮出现「`python-only` 插件**现已停用**…」提醒（来自 `python-only-notice` 行）。
7. 宿主日志里没有 `python-only-notice` 的加载告警。

## 兼容性

- DSH `>=0.2.0-rc.1 <0.3.0-0`。运行时校验字段是 `package.json` 的 `engines.dsh`
  （`dsh-app-boot` 只读这个；`dsh.compatibility` 仅作元数据）。
- host 半部依赖 `@deepseek-ai/schemastery`（`Config` schema）；`tools.guard()`、
  `systemPrompt.section/context()` 为 0.2.x 公开 API。通知行 `lib/notice.js` **零外部依赖**
  （不 import schemastery、不注册 Config），所以即使主插件的依赖解析出问题，它仍能独立加载说话。
- 通知行的 Loader 名是包子路径 `dsh-python-only/notice`（`exports["./notice"]`）：这样
  `dsh-client-modules` 不会把同一个包的客户端 bundle 当成两个来源（只有裸包名参与客户端扫描）。
- 客户端半部声明 `dsh.client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings"] }`，
  由 `dsh-client-modules` 通过 `exports["./client"]` 加载。

## 文件结构

```text
dsh-python-only/
├── package.json        # bundle patch + client 声明 + engines.dsh + exports["./notice"]
├── cordis.patch.yml    # 插入两行：python-only（主）、python-only-notice（常驻通知）
├── lib/index.js        # host：状态驱动的 section/reminder + tools.guard + volatile Config
├── lib/notice.js       # host：常驻状态通知行（主插件被停用时每步告知模型）
├── lib/state.js        # 两个 host 入口之间的进程内状态位（globalThis + Symbol.for）
├── lib/client.js       # 浏览器：设置 →「强制 Python」页（settings.section）
└── README.md
```

## 许可

MIT
