/**
 * dsh-python-only — 主插件（`lib/index.js`）与状态通知插件（`lib/notice.js`）之间的
 * **进程内状态位**。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 「关闭后通知模型」有两种关闭方式，能力边界完全不同：
 *
 *   · 设置页关掉开关 / 把拦截列表清空 —— 主插件还活着，它自己就能把最新状态写进
 *     每步提示词（`systemPrompt.section` / `.context` 的 text 都是函数，每步重算）；
 *   · 在「插件守卫」里把整行 `python-only` 停用 —— 主插件被卸载，**它自己的代码
 *     不再运行**，没有任何回调能再写提示词。这时唯一还活着的是同包的第二个 Loader
 *     行 `python-only-notice`（`name: dsh-python-only/notice`），由它替主插件说话。
 *
 * 两个入口在模块图里可能是不同的模块实例（不同 URL / 不同解析结果），所以状态不能
 * 放在模块作用域里，必须挂在 `globalThis` 上用 `Symbol.for` 索引 —— 与 cosmokit 的
 * volatile 引用协议同一思路：跨副本一致，先到者创建。
 *
 * ── 状态形状 ──────────────────────────────────────────────────────────────
 * ```js
 * {
 *   owners: Map<string, () => Status>,   // 每个活跃主插件实例一条；值函数读 live 配置
 *   everActive: boolean,                 // 本进程内是否至少激活过一次
 *   last: Status | undefined             // 最近一次读到的状态（诊断 / 文案用）
 * }
 * ```
 *
 * `Status` 由主插件定义：`{ enabled, blockedTools, enforcing, offReason }`。
 * 本模块刻意不依赖任何服务、不抛错、不做 I/O：它在 `apply()` 里最早执行，任何异常
 * 都会让整个插件行加载失败，那代价远大于通知本身的价值。
 *
 * @module dsh-python-only/state
 */

/** 进程级槽位（`Symbol.for` 跨模块副本一致）。 */
const STATE_KEY = Symbol.for('dsh-python-only/state');

/**
 * 取（必要时创建）进程级状态登记簿。
 *
 * @returns 共享状态对象；每次调用返回的是同一个引用。
 */
export function registry() {
  const existing = globalThis[STATE_KEY];
  if (existing !== undefined && existing !== null && typeof existing === 'object') {
    return existing;
  }
  const created = { owners: new Map(), everActive: false, last: undefined };
  globalThis[STATE_KEY] = created;
  return created;
}

/**
 * 登记一个活跃的主插件实例。
 *
 * @param owner - 实例标识（用插件名即可；同一实例重复登记会覆盖）。
 * @param read - 读取该实例 live 状态的函数；每次提示词装配 / 每步都会调用。
 * @returns 注销函数（在插件 dispose 时调用），幂等。
 */
export function registerOwner(owner, read) {
  const state = registry();
  state.owners.set(owner, read);
  state.everActive = true;
  return () => {
    const current = registry();
    if (current.owners.get(owner) === read) current.owners.delete(owner);
  };
}

/**
 * 当前活跃主插件报告的状态。
 *
 * @returns 第一条成功返回的状态；没有活跃实例（或读取全部失败）时 `undefined`。
 */
export function activeStatus() {
  const state = registry();
  for (const read of state.owners.values()) {
    try {
      const status = read();
      if (status !== undefined && status !== null) {
        state.last = status;
        return status;
      }
    } catch {
      /* 单个实例读取失败按「没说话」处理，不拖累其它实例 */
    }
  }
  return undefined;
}

/** 本进程内是否曾激活过主插件（用于区分「被停用」与「从未安装」）。 */
export function hasEverActivated() {
  return registry().everActive === true;
}

/** 最近一次读到的状态（可能来自已停用的实例），用于把通知写得更具体。 */
export function lastStatus() {
  return registry().last;
}
