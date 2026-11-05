// app.js — 页面的胶水：读用量、接线控件、走纸动画、把选项存回 plugins.json。
// 经典脚本 + async IIFE：magpie 的沙箱页取不到 type="module"（见 receipt.js 顶上说明）。
(function () {
  "use strict";

  const R = globalThis.MagpieTokenReceipt;
  const buildReceipt = R.buildReceipt;
  const defaults = R.defaults;

  const UI = {
    zh: {
      today: "今日",
      d7: "7 天",
      d30: "30 天",
      reprint: "重打",
      cost: "金额",
      items: "条目",
      all: "全部",
      paper: "纸张",
      papers: { white: "白纸", kraft: "牛皮纸", aged: "旧纸" },
      astext: "文本版",
      hideText: "收起文本",
      printing: "打印中…",
      printed: (s) => `打印于 ${s.time} · ${s.calls} 笔 · ${s.tokens} t`,
      failed: (m) => `读取失败：${m}`,
      saved: "已存",
    },
    en: {
      today: "Today",
      d7: "7 days",
      d30: "30 days",
      reprint: "Reprint",
      cost: "Amount",
      items: "Items",
      all: "All",
      paper: "Paper",
      papers: { white: "White", kraft: "Kraft", aged: "Aged" },
      astext: "Text",
      hideText: "Hide text",
      printing: "printing…",
      printed: (s) => `printed ${s.time} · ${s.calls} calls · ${s.tokens} t`,
      failed: (m) => `read failed: ${m}`,
      saved: "saved",
    },
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    period: $("period"),
    reprint: $("reprint"),
    cost: $("cost"),
    top: $("top"),
    paperBtn: $("paper"),
    feedBtn: $("feed"),
    lang: $("lang"),
    astext: $("astext"),
    status: $("status"),
    printer: $("printer"),
    sheet: $("sheet"),
    text: $("text-box"),
  };

  let opts = Object.assign({}, defaults);
  let summary = null;
  let providers = [];
  let error = "";
  let lastPaint = "";
  let busy = false;
  let feed = true; // 这次重画要不要走纸（手动操作要，自动续打不要）
  let doneText = "";

  const isZh = () => (opts.lang === "zh" ? true : opts.lang === "en" ? false : /^zh/i.test((magpie.theme && magpie.theme.lang) || ""));
  const uiLang = () => (isZh() ? "zh" : "en");
  const u = () => UI[uiLang()];
  const locale = () => (isZh() ? "zh-CN" : "en-GB");
  const clock = (d) => (d || new Date()).toLocaleTimeString(locale(), { hour12: false });
  const num = (n) => new Intl.NumberFormat(isZh() ? "zh-CN" : "en-US").format(Math.round(Number(n) || 0));
  const noMotion = () => !!(window.matchMedia && window.matchMedia("prefers-reduced-motion: reduce").matches);

  function labelControls() {
    const s = u();
    const by = { today: s.today, "7d": s.d7, "30d": s.d30 };
    for (const b of els.period.querySelectorAll("button")) {
      b.textContent = by[b.dataset.p];
      b.classList.toggle("on", b.dataset.p === opts.period);
    }
    els.reprint.textContent = s.reprint;
    els.cost.nextElementSibling.textContent = s.cost;
    els.top.previousElementSibling.textContent = s.items;
    els.top.lastElementChild.textContent = s.all;
    els.paperBtn.textContent = s.paper + ": " + (s.papers[opts.paper] || opts.paper);
    els.lang.textContent = isZh() ? "EN" : "中文";
    els.astext.textContent = els.text.hidden ? s.astext : s.hideText;
  }

  function setStatus(text, bad) {
    els.status.textContent = text;
    els.status.classList.toggle("bad", !!bad);
  }

  function paint() {
    const r = buildReceipt({
      summary,
      providers,
      error,
      options: opts,
      windowLang: (magpie.theme && magpie.theme.lang) || "",
      now: new Date(),
    });
    els.sheet.innerHTML = r.svg;
    els.text.textContent = r.text;
    lastPaint = clock();
    labelControls();

    if (error) doneText = u().failed(error.slice(0, 70));
    else if (summary) doneText = u().printed({ time: lastPaint, calls: num(summary.calls), tokens: num(r.stats.grandTok) });
    else doneText = "";

    // 顶纸：跳步数 = 行数，一步正好一行；时长跟着行数走，长票慢一点
    const animate = feed && opts.animate && !noMotion() && !error;
    els.printer.classList.remove("printing");
    // 纸高先交给机器：rig 的高度 = 纸 + 机身，机身才不会在打印时上下跳
    els.printer.style.setProperty("--mt-h", els.sheet.offsetHeight + "px");
    if (animate) {
      const dur = Math.min(2.6, Math.max(0.85, r.stats.rows * 0.055));
      els.printer.style.setProperty("--mt-dur", dur.toFixed(2) + "s");
      els.printer.style.setProperty("--mt-steps", String(Math.max(6, r.stats.rows)));
      void els.printer.offsetWidth; // 强制重排，同一张票连着重打也能重新起播
      els.printer.classList.add("printing");
      setStatus(u().printing);
    } else {
      setStatus(doneText, !!error);
    }
    feed = true;
  }
  els.printer.addEventListener("animationend", (ev) => {
    if (ev.animationName !== "mt-push") return;
    els.printer.classList.remove("printing");
    setStatus(doneText, false);
  });

  // 选项每秒最多写一次：控件立刻生效，稍后才落盘
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const saved = await magpie.options.set(opts);
        if (saved && typeof saved === "object") opts = Object.assign({}, defaults, saved);
        setStatus(doneText + " · " + u().saved, false);
      } catch {
        /* 窗口不认这次写入；票面已经改了，不影响看 */
      }
    }, 1200);
  }

  function set(patch) {
    opts = Object.assign({}, opts, patch);
    paint();
    persist();
  }

  async function refresh(auto) {
    if (busy) return;
    busy = true;
    feed = !auto; // 自动续打只换纸，不重走一遍
    setStatus(u().printing);
    error = "";
    try {
      summary = await magpie.read("usage:summary", { period: opts.period });
    } catch (e) {
      summary = null;
      error = String((e && e.message) || e);
    }
    try {
      providers = await magpie.read("providers:list");
    } catch {
      providers = []; // 这行店头信息读不到就算了，不影响票面
    }
    busy = false;
    paint();
  }

  // ── 接线 ───────────────────────────────────────────────────────────
  els.period.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.dataset.p === opts.period) return;
    set({ period: b.dataset.p });
    refresh();
  });
  els.reprint.addEventListener("click", () => refresh());
  els.feedBtn.addEventListener("click", () => refresh());
  els.cost.addEventListener("change", () => set({ showCost: els.cost.checked }));
  els.top.addEventListener("change", () => set({ top: Number(els.top.value) }));
  els.paperBtn.addEventListener("click", () => set({ paper: { white: "kraft", kraft: "aged", aged: "white" }[opts.paper] || "white" }));
  els.lang.addEventListener("click", () => set({ lang: isZh() ? "en" : "zh" }));
  els.astext.addEventListener("click", () => {
    els.text.hidden = !els.text.hidden;
    labelControls();
  });

  async function main() {
    await magpie.ready;
    const saved = await magpie.options.get().catch(() => ({}));
    opts = Object.assign({}, defaults, saved || {});
    if (!["today", "7d", "30d"].includes(opts.period)) opts.period = "today";
    els.cost.checked = !!opts.showCost;
    els.top.value = String(opts.top);
    labelControls();
    refresh();

    // 小票只在被看见时自己续打；读者走了就停，别白烧窗口一次读取
    magpie.onTheme(() => labelControls());
    let goneAt = 0;
    magpie.onVisibility((v) => {
      if (!v) goneAt = Date.now();
      else if (opts.auto && goneAt && Date.now() - goneAt > 60000) refresh(true);
    });
    setInterval(() => {
      if (magpie.visible && opts.auto && !busy) refresh(true);
    }, 120000);
  }

  main().catch((e) => setStatus(String((e && e.message) || e), true));
})();
