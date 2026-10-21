/**
 * dsh-python-only — 浏览器半部：设置里的一页「强制 Python」。
 *
 * ── 为什么需要这一半 ──────────────────────────────────────────────────────
 * host 半部导出的 volatile `Config` 会被 settings 服务投影成表单，但 DSH 的
 * 「设置 → 插件」页只渲染**官方插件**的 companion 页面；第三方 bundle 的配置页
 * 必须由本包自己的浏览器 bundle 注册到 slot 上。所以这里注册一个
 * `settings.section`（设置侧栏的独立一页），直接读写 `python-only` 命名空间。
 *
 * ── 数据通道 ──────────────────────────────────────────────────────────────
 * 全部走平台公开面，不碰宿主：
 *   · `ctx.configForms.get("python-only")` → 该命名空间的表单 scope；
 *   · `scope.getSnapshot()` / `scope.subscribe(cb)` → 读取实时值（结构见
 *     host 半部 `Config`：`{ enabled, blockedTools }`）；
 *   · `scope.set(field, value)` / `scope.unset(field)` → 写入 profile 行并
 *     **热更新**运行中的 host 插件实例（volatile 字段，无需重启）。
 *
 * ── 防御性设计 ────────────────────────────────────────────────────────────
 * 平台模块（react / primitives）全部 optional：本 bundle 手写、无构建步骤，
 * 缺 React 时退化为 inert 元素描述，绝不因一个 require 失败把整个设置面板拖垮。
 * 渲染/写入路径也包了 try/catch，失败只在本页显示一行错误。
 *
 * @module dsh-python-only/client
 */
window.__ModuleLoader__.load({
  id: "dsh-python-only",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 取第一个能解析的平台模块；全失败时返回 undefined（降级而非抛错）。 */
    function optionalRequire(...specifiers) {
      for (const specifier of specifiers) {
        try {
          const resolved = require(specifier);
          if (resolved !== undefined && resolved !== null) return resolved;
        } catch {}
      }
      return undefined;
    }

    const platformReact = optionalRequire("react");

    /** 构造一个元素：优先平台 React，缺 React 时退化为可被 slot 渲染器接受的描述。 */
    function element(type, props, ...children) {
      if (platformReact !== undefined && typeof platformReact.createElement === "function") {
        return platformReact.createElement(type, props, ...children);
      }
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
    }

    /** 平台 hooks；缺 React 时给 inert 实现，让模块求值永不出错。 */
    const useState = platformReact !== undefined && typeof platformReact.useState === "function" ? platformReact.useState : (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
    const useEffect = platformReact !== undefined && typeof platformReact.useEffect === "function" ? platformReact.useEffect : () => {};

    /** 本插件在 settings 服务里注册的命名空间（= loader 行 id）。 */
    const SETTINGS_NS = "python-only";

    /** 默认拦截清单（与 host 半部 `DEFAULT_BLOCKED_TOOLS` 保持一致，只作展示兜底）。 */
    const DEFAULT_BLOCKED_TOOLS = ["bash", "pwsh", "terminal_open", "terminal_send", "terminal_read", "terminal_signal", "terminal_close", "terminal_list"];

    /** 从表单快照里安全取出 `{ enabled, blockedTools }`。 */
    function readForm(snapshot) {
      const value = snapshot !== null && typeof snapshot === "object" ? snapshot.value : undefined;
      const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const enabled = object.enabled !== false;
      const blockedTools = Array.isArray(object.blockedTools) ? object.blockedTools.filter((item) => typeof item === "string") : DEFAULT_BLOCKED_TOOLS;
      return { enabled, blockedTools };
    }

    /** 把文本输入解析成工具名数组：逗号 / 顿号 / 空白 / 换行都算分隔符。 */
    function parseTools(text) {
      return String(text ?? "")
        .split(/[\s,，、;；]+/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    /** 页面样式（内联，避免额外 CSS 资源；颜色走平台设计令牌并带回退）。 */
    const styles = {
      page: { maxWidth: "760px", paddingTop: "20px", display: "flex", flexDirection: "column", gap: "18px" },
      header: { display: "flex", flexDirection: "column", gap: "4px" },
      title: { fontSize: "14px", fontWeight: 500, lineHeight: "22px", color: "var(--dsw-alias-label-primary, inherit)" },
      hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #888)" },
      row: { display: "flex", alignItems: "center", gap: "10px", fontSize: "13px", color: "var(--dsw-alias-label-primary, inherit)" },
      block: { display: "flex", flexDirection: "column", gap: "6px" },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: "72px",
        padding: "8px 10px",
        fontSize: "13px",
        lineHeight: "20px",
        fontFamily: "var(--ds-font-family-code, monospace)",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        border: "0.5px solid var(--dsw-alias-border-l3, #ccc)",
        borderRadius: "6px",
        resize: "vertical"
      },
      actions: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      button: {
        cursor: "pointer",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        padding: "6px 14px",
        borderRadius: "6px",
        border: "0.5px solid var(--dsw-alias-border-l3, #ccc)",
        background: "var(--dsw-alias-bg-module-platform, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      primary: {
        cursor: "pointer",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        padding: "6px 14px",
        borderRadius: "6px",
        border: "none",
        background: "var(--dsw-alias-state-business-primary, #4d6bfe)",
        color: "#fff"
      },
      notice: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #888)" },
      error: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #d33)" }
    };

    /**
     * 设置页本体：一个开关 + 一份可编辑的拦截清单。
     *
     * @param props - slot 注入的面（`form`）与平台提供的公共面（可能含 `t`）。
     * @returns 页面元素树。
     */
    function PythonOnlySection(props) {
      const form = props.form;
      let snapshot;
      let readError;
      try {
        snapshot = form.getSnapshot();
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
      const [state, setState] = useState(() => snapshot);
      const current = readForm(state ?? snapshot);
      const [draft, setDraft] = useState(() => current.blockedTools.join(", "));
      const [notice, setNotice] = useState(null);
      const [failure, setFailure] = useState(readError ?? null);

      // 订阅 host 侧变化：设置被别处改动（或写入回执）时刷新表单。
      useEffect(() => {
        if (form === undefined || typeof form.subscribe !== "function") return undefined;
        const off = form.subscribe(() => {
          try {
            setState(form.getSnapshot());
          } catch {
            /* 读取失败时保留上一份快照 */
          }
        });
        return typeof off === "function" ? off : undefined;
      }, [form]);

      // 快照变化时把草稿同步成最新值（用户正在编辑时不覆盖：仅当列表真的变了）。
      const joined = current.blockedTools.join(", ");
      useEffect(() => {
        setDraft(joined);
      }, [joined]);

      /** 执行一次写入，并把结果（成功/失败）显示在页面底部。 */
      const write = (action, okMessage) => {
        setFailure(null);
        try {
          const pending = action();
          if (pending !== undefined && typeof pending.then === "function") {
            pending.then(
              () => setNotice(okMessage),
              (error) => setFailure(`保存失败：${error instanceof Error ? error.message : String(error)}`)
            );
          } else {
            setNotice(okMessage);
          }
        } catch (error) {
          setFailure(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
      };

      const toggle = (next) => {
        write(() => form.set("enabled", next), next ? "已启用（立即生效）" : "已关闭拦截，仅保留提示词（立即生效）");
      };

      const saveTools = () => {
        const tools = parseTools(draft);
        write(() => form.set("blockedTools", tools), tools.length === 0 ? "已清空拦截列表（只剩提示词）" : `已保存 ${String(tools.length)} 个拦截工具（立即生效）`);
      };

      const reset = () => {
        write(() => {
          const first = typeof form.unset === "function" ? form.unset("blockedTools") : form.set("blockedTools", DEFAULT_BLOCKED_TOOLS);
          if (first !== undefined && typeof first.then === "function") {
            return first.then(() => (typeof form.unset === "function" ? form.unset("enabled") : form.set("enabled", true)));
          }
          return typeof form.unset === "function" ? form.unset("enabled") : form.set("enabled", true);
        }, "已恢复默认配置（立即生效）");
      };

      if (form === undefined) {
        return element("div", { style: styles.page }, element("div", { style: styles.error }, "python-only: 设置表单不可用（Host 未提供 python-only 命名空间）"));
      }

      return element(
        "div",
        { style: styles.page },
        element(
          "div",
          { style: styles.header },
          element("div", { style: styles.title }, "强制使用 Python 工具"),
          element("div", { style: styles.hint }, "开启后，一切代码执行与数据处理必须使用 python 工具；下列 shell 工具会被工具守卫直接拒绝（调用返回错误，不会执行）。修改保存后立即生效，无需重启。")
        ),
        element(
          "label",
          { style: styles.row },
          element("input", {
            type: "checkbox",
            checked: current.enabled,
            onChange: (event) => toggle(event.target.checked !== false)
          }),
          element("span", null, current.enabled ? "已启用强制（提示词 + 工具守卫）" : "已关闭拦截（仅保留提示词）")
        ),
        element(
          "div",
          { style: styles.block },
          element("div", { style: styles.hint }, "被拦截的工具名（逗号或换行分隔；清空则只保留提示词约束）："),
          element("textarea", {
            style: styles.textarea,
            value: draft,
            spellCheck: false,
            onChange: (event) => setDraft(event.target.value)
          })
        ),
        element(
          "div",
          { style: styles.actions },
          element("button", { style: styles.primary, type: "button", onClick: saveTools }, "保存拦截列表"),
          element("button", { style: styles.button, type: "button", onClick: reset }, "恢复默认"),
          notice === null ? null : element("span", { style: styles.notice }, notice),
          failure === null ? null : element("span", { style: styles.error }, failure)
        )
      );
    }

    /** 唯一硬依赖：slots（设置面板的注册面）。 */
    const inject = ["slots"];

    /** 客户端插件入口：把页面挂到设置侧栏。 */
    function apply(ctx) {
      ctx.inject(["configForms"], (pageCtx) => {
        let form;
        try {
          form = pageCtx.configForms.get(SETTINGS_NS);
        } catch (error) {
          const logger = ctx.get("logger");
          logger?.warn?.("python-only: 无法读取设置命名空间", error);
          return;
        }
        if (form === undefined || form === null) return;
        // whileServed：Host 真正 serve 该命名空间后才注册页面，避免空页面。
        const register = () =>
          pageCtx.effect(
            () =>
              pageCtx.configForms.whileServed([SETTINGS_NS], () =>
                pageCtx.slots.inject("settings.section", () =>
                  pageCtx.slots.register(
                    {
                      name: "settings.section",
                      id: "python-only",
                      order: 26,
                      label: () => "强制 Python",
                      inject: () => ({ form })
                    },
                    PythonOnlySection
                  )
                )
              ),
            "python-only: settings page"
          );
        try {
          if (typeof pageCtx.configForms.whileServed === "function") {
            register();
          } else {
            pageCtx.slots.inject("settings.section", () =>
              pageCtx.slots.register(
                { name: "settings.section", id: "python-only", order: 26, label: () => "强制 Python", inject: () => ({ form }) },
                PythonOnlySection
              )
            );
          }
        } catch (error) {
          const logger = ctx.get("logger");
          logger?.warn?.("python-only: 设置页注册失败", error);
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
