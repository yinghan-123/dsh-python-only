/**
 * dsh-python-only — 强制 Agent 使用 `python` 工具执行代码与数据处理。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 * DSHM 端侧（手机 / 平板 / PC）的 `python` 工具走**宿主进程内嵌 CPython 3.12**
 * （`@deepseek-ai/dshm-tool-python` → `/dshm-python/*` 桥），不依赖 shell、不依赖
 * guest VM、不 execve；而 `bash` 工具走 guest 虚拟机，启动有内存门槛、且 guest 里
 * 根本没有 python3。模型并不知道这层部署事实，仍会习惯性地用 bash 跑
 * `python3 xxx.py` / `node -e` / heredoc，结果是命令找不到或 VM 起不来。
 *
 * 本插件把「用 python」从**建议**变成**约束**，分两层：
 *
 *   ① 提示词层（引导）：向系统提示注册一个 section（`app:python-only`）并追加
 *      每步动态提醒（`app:python-only-reminder`），明确写出强制规则与运行时边界；
 *   ② 守卫层（硬约束）：注册 `tools.guard()`，对 `bash`（及可配置的同类工具）的
 *      每一次调用直接拒绝，错误文案指向改用 `python`。守卫是**单调**的 ——
 *      一旦拒绝，没有任何插件能重新放行该次调用。
 *
 * ── 设置界面（本插件不写客户端代码，走 DSH 内置设置页）──────────────────
 * 导出带 **volatile** 字段的 `Config` 后，DSH 的 settings 服务会把它投影成
 * 「设置 → 插件 → python-only」里的自动配置表单（前端由 plugin-manager 的
 * `configForms.describe()` 渲染）：
 *
 *   · `enabled`      —— 总开关；关掉后提示词仍生效、但不再拦截工具；
 *   · `blockedTools` —— 被拦截的工具名列表（默认 8 个 shell 通道）。
 *
 * 两个字段都标了 `volatile()`，因此**设置页保存后立即生效**：settings 服务把新值
 * 写回 profile 行的 config，再通过 cosmokit 的 volatile 引用协议原地更新运行中的
 * 插件实例（`get()` 读取），不重挂 fiber、不需要重启。插件内所有读取都走
 * {@link readLive}，永远拿最新值。
 *
 * ── 边界（如实写清，不做过度承诺）────────────────────────────────────────
 * · 本插件**不提供** python 工具本身：端侧由 `@deepseek-ai/dshm-tool-python` 提供；
 *   桌面端由 DSH 自带的 python 工具提供。缺 python 工具时本插件只是把 shell 关掉
 *   （工具面里仍会如实显示缺什么），不会凭空造工具。
 * · 守卫按**工具名**工作：它拦 `bash`/`pwsh`/`terminal_*`，但不拦 `read`/`write`/
 *   `grep`/`web_fetch` 等非执行类工具；文件内容处理被引导到 python 的 `open()`。
 * · 没有"命令白名单"：`git`/`pnpm`/构建命令同样被拦（这是刻意选择 —— 端侧 bash
 *   不可靠，与其半开不如全关）。确需临时用 bash 时在设置页关掉开关，或把工具名从
 *   `blockedTools` 里移出。
 * · 插件是纯 ESM、零运行期外部服务依赖、不写客户端半部：不碰 UI 框架，只在
 *   设置页里贡献一张自动生成的配置卡片。
 *
 * ── 安装形态 ──────────────────────────────────────────────────────────────
 * profile 用户行区（`profiles/<name>/cordis.patch.yml` 的 dshm-user-rows 区块）：
 *
 *     - id: python-only
 *       name: dsh-python-only
 *
 * 首次挂载需要重启 DSHM；之后所有设置改动都是热的（volatile）。
 *
 * @module dsh-python-only
 */
import z from '@deepseek-ai/schemastery';

/** Cordis 插件名（Loader 行的插件身份；npm 包名是 `dsh-python-only`，两者刻意不同）。 */
export const name = 'python-only';

/**
 * 服务依赖在 `apply` 里用嵌套 `ctx.inject` 分支获取，插件本身不硬依赖任何服务
 * —— 缺 `systemPrompt` 时守卫仍然生效，缺 `tools` 时提示词仍然生效。
 */
export const inject = [];

/**
 * 默认拦截的工具名（全部是 shell 通道，一个都不该放行）：
 *   · `bash` —— 端侧模型可用的 shell 工具（`dshm-vm-bash` 只改写它的 spawn 通道，
 *     工具名不变，所以这里按 `bash` 拦得到）；
 *   · `pwsh` —— 桌面 Windows 的 shell 工具，本档不存在，留着零成本；
 *   · `terminal_*` —— 交互式终端工具（`dsh-tool-terminal` 的六个工具）。它是第二条
 *     shell 通道：在能起 PTY 的档位上，模型可以绕开 `bash` 从终端里执行命令，拦掉
 *     才叫"强制"。
 */
const DEFAULT_BLOCKED_TOOLS = Object.freeze([
  'bash',
  'pwsh',
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list'
]);

/** 系统提示 section 的注册名（全局唯一，避免与其它插件撞名）。 */
const SECTION_NAME = 'app:python-only';

/** 每步动态提醒的注册名。 */
const REMINDER_NAME = 'app:python-only-reminder';

/**
 * cosmokit 的 volatile 引用协议符号（`Symbol.for`，跨 ESM/CJS 副本一致）。
 * 引用形如 `{ get(): value, [VOLATILE_WRITE](next): void }`。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 读取一个配置字段的**当前值**。
 *
 * volatile 字段在 schema 解析后是引用对象，`get()` 才拿到值；设置页保存时由
 * settings 服务原地写入。非 volatile / 未解析的值原样返回，缺省时回退到 fallback
 * —— 任何形状的配置都不该让插件抛错。
 *
 * @param node - schema 解析后的字段（可能是 volatile 引用）。
 * @param fallback - 字段缺失时的默认值。
 * @returns 字段当前值。
 */
function readLive(node, fallback) {
  if (node === undefined || node === null) {
    return fallback;
  }
  if (typeof node === 'object' && VOLATILE_WRITE in node && typeof node.get === 'function') {
    const current = node.get();
    return current === undefined ? fallback : current;
  }
  return node;
}

/**
 * 归一化后的拦截集合（每次调用时重新读取，保证设置页改动立即生效）。
 * @param config - 插件配置。
 * @returns 要拦截的工具名集合。
 */
function liveBlockedTools(config) {
  const raw = readLive(config?.blockedTools, DEFAULT_BLOCKED_TOOLS);
  if (!Array.isArray(raw)) {
    return new Set(DEFAULT_BLOCKED_TOOLS);
  }
  const names = raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(names);
}

/** 总开关的当前值（只有显式 `false` 才关闭；缺省 / 非法值一律视为开启）。 */
function liveEnabled(config) {
  return readLive(config?.enabled, true) !== false;
}

/** 把拦截集合渲染成提示词里的工具清单。 */
function blockedSummary(blocked) {
  const names = [...blocked];
  return names.length === 0 ? '（当前设置里没有配置任何拦截项）' : names.map((item) => `\`${item}\``).join('、');
}

/**
 * 系统提示正文：规则必须写成模型可以直接执行的判断标准，而不是口号。
 *
 * 措辞刻意区分「必须用 python 做的事」与「仍然可用的工具」，否则模型会把
 * read/grep 也当成违规而不去查文件 —— 那会让会话质量下降，不是本插件的目的。
 * 拦截清单按实时配置渲染，设置页一改，下一轮提示词就反映出来。
 *
 * @param blocked - 当前拦截的工具名集合。
 * @returns 系统提示 section 正文。
 */
function sectionText(blocked) {
  return `# 强制 Python 工具（python-only）

本环境安装了 \`python-only\` 插件，它对工具使用施加硬约束：**一切代码执行与数据处理必须使用 \`python\` 工具**。

## 必须用 \`python\` 工具完成的事
- 执行任何代码、脚本、计算、数据转换、统计与校验。
- 解析、生成、批量改写文件内容（JSON / CSV / 文本 / 正则处理等）。需要读写文件内容时，在 python 里用 \`open()\`。
- 任何"跑一下看看结果"的验证。

调用方式：短代码用 \`code\` 参数（内联，≤ 8 KiB）；长代码先用 \`write\` 落成 .py 文件，再用 \`file\` 参数执行（可带 \`args\`）。

## 禁止
- **不要调用以下工具（已被工具守卫拦截，调用会直接返回错误、不会执行）**：${blockedSummary(blocked)}。
- 不要试图通过 shell 或终端调用 \`python3\`、\`node\`、\`perl\` 等解释器 —— 本档 shell 里没有它们。

## 仍然可用
- \`read\` / \`glob\` / \`grep\` 等只读检索工具照常使用（查看文件、找符号）。
- \`web_fetch\` / \`web_search\` / 子代理 / 计划与待办等非执行类工具不受限制。

## python 运行时边界（据此设计代码）
- 运行在宿主进程内的内嵌 CPython 3.12：标准库齐全；**没有第三方 C 扩展**（numpy/PIL/lxml 等不可用），**没有子进程**（\`subprocess\` / \`os.system\` 必然失败）。
- 执行是同步阻塞的：单次默认 120 秒上限（可传 \`timeoutSec\`，最大 300），长任务拆成小步。
- 内嵌解释器跨调用常驻：全局变量与已 import 的模块在后续调用中仍在，需要干净环境时自行重置。`;
}

/**
 * 每步动态提醒：system prompt 早已装配的会话里，靠它在每次模型调用前再压一遍规则。
 * @param blocked - 当前拦截的工具名集合。
 * @returns 动态提示正文。
 */
function reminderText(blocked) {
  return `提醒：本会话强制使用 \`python\` 工具——代码执行 / 计算 / 数据处理一律走 \`python\`（文件内容用 open() 读写）；${blockedSummary(blocked)} 已被工具守卫拦截，调用只会得到错误。`;
}

/**
 * 生成守卫的拒绝文案。
 *
 * 守卫返回的字符串会成为工具结果的 `Error: <reason>`，模型下一轮就能读到，
 * 所以文案必须**可行动**：说清为什么被拒、改成用什么、以及 python 工具怎么调。
 *
 * @param toolName - 被拒绝的工具名。
 * @returns 面向模型的拒绝理由。
 */
function denialReason(toolName) {
  return `本环境强制使用 python 工具：\`${toolName}\` 已被 python-only 插件禁用（工具守卫拒绝本次调用）。请改用 \`python\` 工具完成该操作：代码走 \`code\` 参数，脚本先 \`write\` 成 .py 文件再用 \`file\` 参数执行；文件内容在 python 里用 open() 读写。`;
}

/**
 * 插件配置 schema —— 同时是「设置 → 插件 → python-only」自动配置表单的来源。
 *
 * 两个字段都声明 `volatile()`：settings 服务据此把它们投影成可编辑表单，并在
 * 保存时通过 volatile 引用原地更新运行中的实例（无需重启）。
 *
 * @property enabled - 总开关。`true`（默认）时拦截 shell 工具；`false` 时只保留提示词。
 * @property blockedTools - 被拦截的工具名列表；默认是全部 shell 通道。
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('总开关：关闭后系统提示仍生效，但不再拦截 shell 工具')
    .volatile(),
  blockedTools: z
    .array(z.string())
    .default([...DEFAULT_BLOCKED_TOOLS])
    .description('被拦截的工具名列表（默认 bash、pwsh 与六个 terminal_*）')
    .volatile()
});

/**
 * 插件入口。
 *
 * @param ctx - Host 插件上下文。
 * @param config - schema 解析后的配置；volatile 字段是活引用，读取一律走 {@link readLive}。
 */
export function apply(ctx, config) {
  // 提示词层：section 提供完整规则，context 每步重申。两者各自独立，
  // 任一服务缺失都不影响另一层（也都不影响下面的守卫）。
  // text 是函数：每次提示词装配时重新读取 live 配置，设置页改动立即反映。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: SECTION_NAME,
      order: 90,
      text: () => sectionText(liveBlockedTools(config))
    });
    promptCtx.systemPrompt.context({
      name: REMINDER_NAME,
      order: 1000,
      text: () => reminderText(liveBlockedTools(config))
    });
  });

  // 守卫层：同步检查每一次工具执行；返回 string 即拒绝，返回 undefined 即放行。
  // 每次调用都重新读 live 配置 —— 设置页关掉开关后，下一次工具调用立刻放行。
  ctx.inject(['tools'], (toolsCtx) => {
    if (typeof toolsCtx.tools?.guard !== 'function') {
      const logger = ctx.get?.('logger');
      logger?.warn?.('python-only: tools.guard() 不可用，shell 工具不会被拦截（仅提示词生效）');
      return;
    }
    toolsCtx.tools.guard((exec) => {
      if (!liveEnabled(config)) {
        return undefined;
      }
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      if (!liveBlockedTools(config).has(toolName)) {
        return undefined;
      }
      return denialReason(toolName);
    });
  });
}

/** 导出给自检脚本 / 其它插件使用：默认拦截列表、配置 schema 与渲染函数。 */
export { DEFAULT_BLOCKED_TOOLS, denialReason, liveBlockedTools, liveEnabled, readLive, reminderText, sectionText };
