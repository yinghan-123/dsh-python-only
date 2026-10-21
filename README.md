# dsh-python-only

> GitHub：https://github.com/yinghan-123/dsh-python-only · 一行安装：`pnpm add github.com/yinghan-123/dsh-python-only`

强制 DeepSeek Harness（DSH）的 Agent **一切代码执行与数据处理都使用 `python` 工具**，并用工具守卫**拦截 shell 类工具**。为 DSHM 端侧（HarmonyOS 手机 / 平板 / PC）设计：端侧 `python` 工具跑在宿主进程内的内嵌 CPython 3.12（不 execve、不依赖 guest VM），而 `bash` 走 guest 虚拟机、guest 里没有 python3。

## 它做什么

两层约束同时生效：

| 层 | 机制 | 效果 |
| --- | --- | --- |
| 提示词 | `systemPrompt.section`（`app:python-only`）+ 每步动态提醒（`app:python-only-reminder`） | 模型在第一次思考时就知道必须用 `python`，并知道运行时边界 |
| 守卫 | `tools.guard()` 同步拦截 | 模型若仍调用 `bash` / `pwsh` / `terminal_*`，调用被**直接拒绝**（结果 `Error: …`），文案指向改用 `python` |

守卫是单调的：一旦拒绝，没有任何插件能重新放行该次调用。

## 设置界面

**设置 → 侧栏「强制 Python」**（客户端半部 `lib/client.js` 注册 `settings.section`，order 26）。
页面内容：

| 控件 | 作用 |
| --- | --- |
| 开关 | 总开关；关闭后提示词仍生效、但不再拦截工具 |
| 拦截工具列表 | 逗号/换行分隔的工具名，默认 `bash`、`pwsh`、`terminal_open/send/read/signal/close/list` |
| 保存 / 恢复默认 | 写入 profile 行并**立即生效** |

实现要点：

- **为什么需要客户端半部**：DSH 的「设置 → 插件」页只渲染**官方插件**的 companion 配置页；第三方 bundle 的配置页必须由包自己的浏览器 bundle 注册到 slot。本插件注册一个独立设置页，不依赖任何官方 UI 包的其他接口。
- **数据通道**全部走平台公开面：`ctx.configForms.get("python-only")` 拿表单 scope，`getSnapshot()/subscribe()` 读、`set()/unset()` 写。
- **热生效**：host 半部的 `Config` 字段都标了 `volatile()`，写入经 settings 服务落回 profile 行、再由 cosmokit 的 volatile 引用原地更新运行中的实例 —— 设置页保存后无需重启。
- 平台模块（`react`、primitives）全部 optional，缺 React 时退化为 inert 渲染而不是拖垮设置面板。

> 也可以直接写 profile 行的 `config`（见下节），两种方式等价。

## 不做什么

- **不提供** python 工具本身。端侧由 `@deepseek-ai/dshm-tool-python` 提供；桌面端由 DSH 自带 python 工具提供。
- 不拦 `read` / `glob` / `grep` / `web_fetch` / `web_search` / 子代理等非执行类工具。
- 没有命令白名单：`git`、`pnpm`、构建命令同样被拦（刻意选择——端侧 bash 不可靠，与其半开不如全关）。
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
   "dependencies": { "dsh-python-only": "1.0.0" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-python-only" ] } }
   ```

   （行由包自带的 `cordis.patch.yml` 插入，不依赖会被种子重建的 `dshm-user-rows` 用户区。）

3. **配置覆盖行**（让设置页能读到该行）：`profiles/ondevice/cordis.patch.yml` 的**用户行区之外**加

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

4. **重启 DSHM** 一次（profile 的 `patchReload` 是 `startup`；客户端 bundle 也只在启动时被 `dsh-client-modules` 扫描）。

## 停用 / 回滚

- **临时放行 shell**：设置页关掉开关（立即生效）。
- **完全停用**：`package.json` 的 bundles 里去掉 `dsh-python-only`（或给行加 `disabled: true`），重启。
- **彻底移除**：删 `node_modules/dsh-python-only/`、bundles/dependencies 条目与那行 config，重启。

## 验证清单

1. 设置侧栏出现「强制 Python」页，开关与列表可编辑，保存后立即生效。
2. Agent 调 `bash` → 返回 `Error: 本环境强制使用 python 工具：\`bash\` 已被 python-only 插件禁用…`。
3. Agent 用 `python` 跑代码 → 正常返回。
4. 系统提示里出现「# 强制 Python 工具（python-only）」段。

## 兼容性

- DSH `>=0.2.0-rc.1 <0.3.0-0`。运行时校验字段是 `package.json` 的 `engines.dsh`
  （`dsh-app-boot` 只读这个；`dsh.compatibility` 仅作元数据）。
- host 半部依赖 `@deepseek-ai/schemastery`（`Config` schema）；`tools.guard()`、
  `systemPrompt.section/context()` 为 0.2.x 公开 API。
- 客户端半部声明 `dsh.client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings"] }`，
  由 `dsh-client-modules` 通过 `exports["./client"]` 加载。

## 文件结构

```text
dsh-python-only/
├── package.json        # bundle patch + client 声明 + engines.dsh
├── cordis.patch.yml    # 插入 - id: python-only / name: dsh-python-only
├── lib/index.js        # host：提示词 section/reminder + tools.guard + volatile Config
├── lib/client.js       # 浏览器：设置 →「强制 Python」页（settings.section）
└── README.md
```

## 许可

MIT
