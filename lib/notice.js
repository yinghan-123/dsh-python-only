/**
 * dsh-python-only — 状态通知行（常驻，`name: dsh-python-only/notice`）。
 *
 * ── 为什么需要单独一行 ────────────────────────────────────────────────────
 * 「关闭后通知模型」有三种关闭方式，其中两种主插件自己就能说（设置页关开关、
 * 拦截列表清空 —— 主插件还活着，`systemPrompt` 的 text 函数每步重算，见
 * `lib/index.js`）。
 *
 * 第三种是**在「插件守卫」里把整行 `python-only` 停用**：主插件被卸载，它注册的
 * section / context 随之消失，也没有任何回调会在"下一步"执行 —— 模型于是只看得见
 * 历史里那句过期的「必须用 python、bash 已被拦截」。
 *
 * 本行的唯一职责就是补上这一句话：它**永不参与拦截**、不注册配置、不提供设置页，
 * 只注册一条每步动态上下文（`app:python-only-status`），读 `lib/state.js` 里的
 * 进程内状态位：
 *
 *   · 主插件活着            → 输出空串，让主插件自己说（避免同一句话出现两遍）；
 *   · 主插件曾活跃、现在没了 → 输出「python-only 已被停用」通知；
 *   · 主插件从未激活过      → 再看 Loader 里是否有被禁用的 python-only 行：
 *                             有（本次启动即停用）就通知，没有（从未安装）就沉默。
 *
 * 空串会被 `systemPrompt` 过滤掉，因此沉默是零成本的（不会给模型多一条空消息）。
 *
 * ── 边界（如实写清）──────────────────────────────────────────────────────
 * · 只对「停用（disabled）」有效：把包**卸载**掉时本行与主行一起消失，谁也发不出话；
 * · 本行不是 `dependencies` 里的包名 → 「插件守卫」的列表里看不到它、也停不了它，
 *   想彻底停用要直接改 profile 的 `cordis.patch.yml`（或卸载整个包）；
 * · 它刻意零依赖（不 import schemastery，也不注册 Config）：这一行存在的意义就是
 *   「别的都倒了时它还能说话」，任何加载期依赖都会把这个意义抹掉。
 *
 * @module dsh-python-only/notice
 */
import { activeStatus, hasEverActivated, lastStatus } from './state.js';

/** Cordis 插件名（与主插件 `python-only` 区分；npm 包名仍是 `dsh-python-only`）。 */
export const name = 'python-only-notice';

/** 无服务硬依赖：缺 `systemPrompt` 时静默降级，不拖垮启动。 */
export const inject = [];

/** 每步状态通知的注册名（与主插件的 `app:python-only-reminder` 分开）。 */
const STATUS_CONTEXT = 'app:python-only-status';

/** Loader 里可能代表主插件的行标识（bundle patch 用 npm 包名，用户行区可能用 id）。 */
const PYTHON_ONLY_ROW_NAMES = new Set(['dsh-python-only', 'python-only']);

/**
 * Loader 树里是否存在**被停用**的 python-only 主行。
 *
 * 用于「本次启动时就已经是停用状态」：那时主插件从未激活过，靠
 * {@link hasEverActivated} 判断不出来，但它确实还留在 Loader 树里（只是 disabled）。
 *
 * @param ctx - 本插件上下文。
 * @returns 找到被停用的主行时 `true`；读取失败一律 `false`。
 */
function disabledPythonOnlyRow(ctx) {
  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
    if (loader === undefined || loader === null || typeof loader.entries !== 'function') {
      return false;
    }
    for (const entry of loader.entries()) {
      const options = entry?.options;
      if (options === undefined || options === null) continue;
      const rowName = typeof options.name === 'string' ? options.name : '';
      const rowId = typeof options.id === 'string' ? options.id : '';
      if (!PYTHON_ONLY_ROW_NAMES.has(rowName) && !PYTHON_ONLY_ROW_NAMES.has(rowId)) continue;
      if (entry.disabled === true) return true;
    }
  } catch {
    /* 读不到 Loader 就当没停用 —— 沉默比误报安全 */
  }
  return false;
}

/**
 * 停用通知正文。
 *
 * @param mode - `runtime`（运行中被停用）或 `startup`（本次启动即停用）。
 * @param blocked - 停用前最后见过的拦截清单（可能缺失）。
 * @returns 每步提示正文。
 */
function noticeText(mode, blocked) {
  const last = Array.isArray(blocked) && blocked.length > 0 ? blocked.map((item) => `\`${item}\``).join('、') : 'shell 工具';
  const cause = mode === 'startup' ? '本次启动时就处于停用状态' : '刚刚被停用';
  return `提醒：\`python-only\` 插件**现已停用**（${cause}）——工具守卫不再拦截任何工具，${last} 可以直接调用并真实执行；\`python\` 工具仍然可用。此前「必须用 python、shell 已被拦截」的提示是**旧状态**，以本条为准。需要恢复强制：在「插件守卫」里重新启用 python-only，或把 \`dsh-python-only\` 行加回 profile 的 \`cordis.patch.yml\`。`;
}

/**
 * 计算本步要输出的通知文本（空串 = 沉默）。
 *
 * @param ctx - 本插件上下文。
 * @returns 通知正文或空串。
 */
function currentNotice(ctx) {
  if (activeStatus() !== undefined) {
    // 主插件活着：它自己会把「强制中」或「已关闭」写进提示词，这里不能重复。
    return '';
  }
  const last = lastStatus();
  const blocked = last !== undefined && last !== null && last.blockedTools !== undefined
    ? [...(last.blockedTools instanceof Set ? last.blockedTools : Array.isArray(last.blockedTools) ? last.blockedTools : [])]
    : undefined;
  if (hasEverActivated()) {
    return noticeText('runtime', blocked);
  }
  if (disabledPythonOnlyRow(ctx)) {
    return noticeText('startup', blocked);
  }
  // 从未激活、也没有被停用的行：要么没装，要么加载失败 —— 不说话最安全。
  return '';
}

/**
 * 本行入口：只注册一条每步动态上下文。
 *
 * @param ctx - Host 插件上下文。
 */
export function apply(ctx) {
  try {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        promptCtx.systemPrompt.context({
          name: STATUS_CONTEXT,
          order: 1001,
          text: () => currentNotice(ctx)
        });
      } catch (error) {
        ctx.get?.('logger')?.warn?.('python-only-notice: 状态上下文注册失败', error);
      }
    });
  } catch (error) {
    // 本行是"兜底说话"用的，任何异常都只记日志，绝不能把插件行拖成加载失败。
    try {
      ctx.get?.('logger')?.warn?.('python-only-notice: 初始化失败（不影响主插件）', error);
    } catch {
      /* logger 也拿不到时放弃 —— 保持进程干净 */
    }
  }
}
