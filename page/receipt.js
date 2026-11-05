// receipt.js — 把用量画成一张热敏小票。纯函数：进 JSON，出 SVG 字符串 + 可复制的文本版。
// 不碰 DOM、不碰 magpie 桥，所以能在 node 里直接单测，也能被别的宿主复用。
// magpie 的插件页是沙箱里的经典脚本：type="module" 会以 CORS 模式取脚本，页面服务不回 CORS 头就取不到，
// 所以这里不用 import/export，整份包在 IIFE 里，要用的挂到 globalThis.MagpieTokenReceipt。
(function (root) {
  "use strict";

  const W = 336; // 纸宽（28 个 12px 锯齿，正好铺满）
  const PAD = 24; // 纸内左右留白
  const G = 18; // 视图留白，够放锯齿和投影
  const QTY_COL = 58; // 数量列右沿距金额列右沿：够放 "0.0000" 或 "免费"
  const MID = G + W / 2; // 双栏元信息的中缝

  const defaults = {
    lang: "auto", // auto 跟窗口语言
    period: "today",
    top: 12, // 最多列出多少件"商品"，其余并进"其他"一行
    showCost: true,
    stamp: true,
    paper: "white", // white | kraft | aged
    animate: true,
    store: "", // 店名，留空用默认
    address: "", // 地址行，留空用供应商清单
    cashier: "MAGPIE",
    auto: true, // 页面被看见时每两分钟自动续打一次
  };

  const STR = {
    zh: {
      locale: "zh-CN",
      store: "Magpie 模型超市",
      sub: "TOKEN 消耗小票",
      hours: "营业 00:00-24:00 · 全时段自助",
      items: "名称",
      qty: "数量(t)",
      amount: "金额($)",
      date: "日期",
      period: "时段",
      since: "起于",
      term: "终端",
      receipt: "票号",
      cashier: "收银",
      dept: "柜台",
      rest: "其他",
      restUnit: "种",
      restCache: "缓存与其他",
      calls: "交易笔数",
      errors: "退货(失败)",
      input: "输入",
      output: "输出",
      cache: "缓存读",
      total: "合计 TOKENS",
      due: "应付金额",
      free: "免费",
      freeOf: "其中",
      freeOf2: "件免费",
      pay: "支付方式：套餐额度",
      points: "积分",
      pointsNote: "每 1000 token 积 1 分",
      periods: { today: "今日", "7d": "近 7 天", "30d": "近 30 天" },
      unit: "笔",
      stamp: "已付款",
      stampSub: "magpie 网关",
      copy: "第 1/1 联 · 客户联",
      thanks: "谢谢惠顾 · 欢迎再次光临",
      policy: "已消耗 TOKEN 不退不换",
      printed: "本小票由 magpie 打印 · 热敏无碳",
      blank: "本时段还没有用量",
      failed: "打印失败",
      failedHint: "读不到用量，稍后点“重打”",
      providers: "本店经营",
      providers2: "家供应商",
      sep: "、",
    },
    en: {
      locale: "en-US",
      store: "MAGPIE MODEL MART",
      sub: "TOKEN USAGE RECEIPT",
      hours: "OPEN 00:00-24:00 · SELF SERVICE",
      items: "ITEM",
      qty: "QTY(t)",
      amount: "AMT($)",
      date: "DATE",
      period: "PERIOD",
      since: "SINCE",
      term: "TERM",
      receipt: "RECEIPT NO",
      cashier: "CASHIER",
      dept: "DEPT",
      rest: "Other items",
      restUnit: "more",
      restCache: "cache & rounding",
      calls: "TRANSACTIONS",
      errors: "VOID (errors)",
      input: "INPUT",
      output: "OUTPUT",
      cache: "CACHE READ",
      total: "TOTAL TOKENS",
      due: "AMOUNT DUE",
      free: "free",
      freeOf: "of which",
      freeOf2: "items free",
      pay: "TENDERED: plan allowance",
      points: "POINTS",
      pointsNote: "1 point per 1000 tokens",
      periods: { today: "TODAY", "7d": "LAST 7 DAYS", "30d": "LAST 30 DAYS" },
      unit: "",
      stamp: "PAID",
      stampSub: "magpie gateway",
      copy: "COPY 1 OF 1 · CUSTOMER",
      thanks: "THANK YOU · COME AGAIN",
      policy: "CONSUMED TOKENS ARE NON-REFUNDABLE",
      printed: "printed by magpie · thermal carbonless",
      blank: "no usage in this window",
      failed: "PRINT FAILED",
      failedHint: "could not read usage; reprint later",
      providers: "COUNTER SERVES",
      providers2: "providers",
      sep: ", ",
    },
  };

  const pad2 = (n) => String(n).padStart(2, "0");

  /** FNV-1a：票号、条码、机号全从它来 —— 同样的用量永远打出同一张票 */
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  const hex = (n, len) => (((n >>> 0) ^ 0x9e3779b9) >>> 0).toString(16).toUpperCase().padStart(len, "0").slice(-len);

  function pickLang(want, windowLang) {
    return want === "zh" || want === "en" ? want : /^zh/i.test(windowLang || "") ? "zh" : "en";
  }

  function fmtInt(n, locale) {
    return new Intl.NumberFormat(locale).format(Math.round(Number(n) || 0));
  }

  /** 小钱要看得见：$0.2004；上千收成整数 */
  function fmtMoney(v) {
    const n = Number(v) || 0;
    if (n <= 0) return null; // 0 由"免费"表达
    return n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(2) : n.toFixed(4);
  }

  const fmtDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtClock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  /** magpie 的 models 里同名可能重复（同一模型走不同供应商/账号）；小票上是同一件商品 */
  function mergeItems(models) {
    const by = new Map();
    for (const m of models || []) {
      const name = String(m?.model ?? m?.name ?? "?");
      const cur = by.get(name) || { name, calls: 0, tok: 0, cost: 0, hosts: 0 };
      cur.calls += Number(m?.calls) || 0;
      cur.tok += (Number(m?.input) || 0) + (Number(m?.output) || 0);
      cur.cost += Number(m?.cost) || 0;
      cur.hosts += 1;
      by.set(name, cur);
    }
    return [...by.values()].sort((a, b) => b.tok - a.tok || b.cost - a.cost || (a.name < b.name ? -1 : 1));
  }

  /** providers:list 的形状文档没写死：可能给字符串、给对象，或外面包一层 */
  function providerNames(providers) {
    const raw = Array.isArray(providers)
      ? providers
      : Array.isArray(providers?.providers)
        ? providers.providers
        : Array.isArray(providers?.data)
          ? providers.data
          : Array.isArray(providers?.result)
            ? providers.result
            : [];
    const out = [];
    for (const p of raw) {
      const n = typeof p === "string" ? p : p?.name ?? p?.label ?? p?.title ?? p?.id;
      if (n) out.push(String(n));
    }
    return out;
  }

  /** 条码：条宽由 hash 决定，看着像 Code128，实际只是画出来 */
  function barcodeSvg(seed, w, h) {
    let x = 0,
      s = seed >>> 0,
      bars = "";
    while (x < w - 4) {
      const bw = 1 + (s % 4);
      const gp = 1 + ((s >> 5) % 2);
      bars += `<rect x="${x.toFixed(2)}" width="${(bw * 0.85).toFixed(2)}" height="${h}"/>`;
      x += bw + gp;
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    }
    return `<g class="mt-bars">${bars}</g>`;
  }

  // ── 行模型 ────────────────────────────────────────────────────────────────
  const center = (t, cls = "") => ({ k: "center", t, cls });
  // l 左标题；vals 右对齐的数字列（showCost 时最后一列落在金额列）
  // mark: "" | "head" | "item" | "total" | "due"；tip 悬停全文；suffix 名字后那截淡字（×次数）
  const row = (l, vals = [], cls = "", mark = "", tip = "", suffix = "") => ({ k: "row", l, vals, cls, mark, tip, suffix });
  const kv2 = (l1, v1, l2, v2, cls = "") => ({ k: "kv2", l1, v1, l2, v2, cls });
  const rule = (style = "solid") => ({ k: "rule", style });
  const gap = (h = 6) => ({ k: "gap", h });
  const band = (h = 56) => ({ k: "band", h }); // 给红章留的空白带，章不许压在字上
  const barcode = (digits) => ({ k: "barcode", digits });

  const centerH = (cls) => (cls.includes("mt-lg") ? 19 : cls.includes("mt-md") ? 17 : cls.includes("mt-sm") ? 12.5 : 15.5);
  const rowH = (cls) => (cls.includes("mt-lg") ? 21 : cls.includes("mt-md") ? 18 : 15);

  // 一条线自己占一个槽：线画在槽顶往下 RULE_INK 处，槽底给下一行的上伸部留够 —— 线绝不许穿字
  const RULE_INK = 5;
  const ruleSlot = (style) => (style === "thick" ? 22 : 18);

  function layout(lines) {
    let y = G + 26;
    const placed = [];
    for (const ln of lines) {
      if (ln.k === "gap") {
        y += ln.h;
        continue;
      }
      const h =
        ln.k === "center" ? centerH(ln.cls) : ln.k === "row" || ln.k === "kv2" ? rowH(ln.cls) : ln.k === "rule" ? ruleSlot(ln.style) : ln.k === "barcode" ? 52 : ln.k === "band" ? ln.h : 8;
      placed.push({ ...ln, y, h });
      y += h;
    }
    return { placed, height: Math.max(320, Math.round(y + 6 - G)) };
  }

  function truncate(s, max) {
    const t = String(s ?? "");
    return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
  }

  /**
   * @param {object}      p
   * @param {object|null} p.summary      magpie.read("usage:summary") 原样返回
   * @param {*}           p.providers    magpie.read("providers:list") 原样返回（可缺）
   * @param {string}      [p.error]      读取失败原因；有它就不画数字、画故障
   * @param {object}      [p.options]    已和 defaults 合并的选项
   * @param {string}      [p.windowLang] magpie.theme.lang
   * @param {Date}        [p.now]
   */
  function buildReceipt(p = {}) {
    const o = { ...defaults, ...(p.options || {}) };
    const lang = pickLang(o.lang, p.windowLang);
    const t = STR[lang];
    const now = p.now instanceof Date ? p.now : new Date(p.now ?? Date.now());
    const sum = p.summary && !p.error ? p.summary : null;

    const periodKey = ["today", "7d", "30d"].includes(String(o.period)) ? String(o.period) : "today";
    const periodLabel = t.periods[periodKey];

    const items = sum ? mergeItems(sum.models) : [];
    const listed = Number(o.top) > 0 ? items.slice(0, Number(o.top)) : items;
    const restCount = items.length - listed.length;

    // 一件商品的"数量"= 输入+输出 token；缓存读只有合计数，所以它单列在合计里，账仍然平
    const billTok = sum ? (Number(sum.input) || 0) + (Number(sum.output) || 0) : 0;
    const cacheTok = sum ? Number(sum.cacheRead) || 0 : 0;
    const grandTok = billTok + cacheTok;
    const listedTok = listed.reduce((a, m) => a + m.tok, 0);
    const restTok = Math.max(0, billTok - listedTok);
    const listedCost = listed.reduce((a, m) => a + m.cost, 0);
    const restCost = Math.max(0, (sum ? Number(sum.cost) || 0 : 0) - listedCost);
    const freeItems = items.filter((m) => !m.cost).length;

    const seedSrc = [sum?.period ?? periodKey, sum?.since ?? "", sum?.calls ?? 0, sum?.input ?? 0, sum?.output ?? 0, sum?.cacheRead ?? 0, (sum?.cost ?? 0).toFixed(6)].join("|");
    const h = hash32(seedSrc);
    const receiptNo = `${hex(h, 4)}-${hex(h >> 7, 4)}`;
    const term = `T-${(h % 89) + 10}`;
    const dept = `L-${(h % 8) + 1}`;
    const barNum = String(h).padStart(10, "0").slice(0, 10);
    const barPrint = `${barNum.slice(0, 4)} ${barNum.slice(4, 8)} ${barNum.slice(8)}`;
    const store = String(o.store || t.store).toUpperCase();
    const names = providerNames(p.providers);
    const money = (v) => (fmtMoney(v) ?? t.free);

    const lines = [];
    lines.push(center(store, "mt-lg mt-spaced"));
    lines.push(center(t.sub, "mt-sm mt-dim"));
    lines.push(gap(3));
    lines.push(rule("solid"));
    lines.push(center(t.hours, "mt-sm mt-faint"));

    if (p.error) {
      lines.push(center(t.failed, "mt-md"));
      lines.push(center(truncate(p.error, 46), "mt-sm mt-dim"));
      lines.push(gap(3));
      lines.push(center(t.failedHint, "mt-sm mt-faint"));
    } else {
      lines.push(row(t.date, [`${fmtDay(now)} ${fmtClock(now)}`], "mt-sm"));
      lines.push(row(t.period, [periodLabel], "mt-sm"));
      if (sum?.since) {
        const d = new Date(sum.since);
        if (!Number.isNaN(d.getTime())) lines.push(row(t.since, [`${fmtDay(d)} ${fmtClock(d)}`], "mt-sm mt-faint"));
      }
      lines.push(kv2(t.term, term, t.receipt, receiptNo, "mt-sm"));
      lines.push(kv2(t.cashier, String(o.cashier || "MAGPIE").toUpperCase(), t.dept, dept, "mt-sm"));
      if (o.address) lines.push(center(truncate(o.address, 44), "mt-sm mt-faint"));
      else if (names.length) {
        lines.push(center(`${t.providers} ${names.length} ${t.providers2}`, "mt-sm mt-faint"));
        lines.push(center(truncate(names.slice(0, 7).join(t.sep) + (names.length > 7 ? "…" : ""), 44), "mt-sm mt-faint"));
      }
    }
    lines.push(rule("dash"));

    if (!p.error && sum) {
      if (!items.length) lines.push(center(t.blank, "mt-sm mt-dim"));
      lines.push(row(t.items, [t.qty, o.showCost ? t.amount : ""], "mt-sm mt-dim", "head"));
      for (const m of listed) {
        const nm = truncate(m.name, 22);
        const vals = [fmtInt(m.tok, t.locale)];
        if (o.showCost) vals.push(money(m.cost));
        lines.push(row(nm, vals, nm.length >= 22 ? "mt-tight" : "mt-item", "item", m.name, m.calls > 1 ? `×${m.calls}` : ""));
      }
      if (restCount > 0 || restTok > 0) {
        const label = restCount ? `${t.rest} ${restCount} ${t.restUnit}` : t.restCache;
        const vals = [fmtInt(restTok, t.locale)];
        if (o.showCost) vals.push(money(restCost));
        lines.push(row(truncate(label, 24), vals, "mt-sm mt-dim"));
      }
      lines.push(rule("dash"));
      const u = t.unit ? ` ${t.unit}` : "";
      lines.push(row(t.calls, [fmtInt(sum.calls, t.locale) + u], "mt-sm"));
      lines.push(row(t.errors, [fmtInt(sum.errors, t.locale) + u], sum.errors ? "mt-sm mt-warn" : "mt-sm mt-faint"));
      lines.push(row(t.input, [fmtInt(sum.input, t.locale)], "mt-sm mt-dim"));
      lines.push(row(t.output, [fmtInt(sum.output, t.locale)], "mt-sm mt-dim"));
      lines.push(row(t.cache, [fmtInt(sum.cacheRead, t.locale)], "mt-sm mt-dim"));
      lines.push(rule("thick"));
      lines.push(row(t.total, [fmtInt(grandTok, t.locale)], "mt-md mt-bold", "total"));
      if (o.showCost) lines.push(row(t.due, [`$ ${fmtMoney(sum.cost) ?? "0.0000"}`], "mt-md mt-bold", "due"));
      lines.push(rule("thick"));
      lines.push(center(t.pay, "mt-sm mt-dim"));
      if (freeItems) lines.push(center(`${t.freeOf} ${freeItems} ${t.freeOf2}`, "mt-sm mt-faint"));
      lines.push(row(t.points, [`+${fmtInt(Math.floor(grandTok / 1000), t.locale)}`], "mt-sm"));
      lines.push(center(t.pointsNote, "mt-sm mt-faint"));
    }

    lines.push(band(o.stamp && sum && !p.error ? 56 : 14));
    lines.push(rule("dash"));
    lines.push(barcode(barPrint));
    lines.push(gap(5));
    lines.push(center(t.thanks, "mt-sm"));
    lines.push(center(t.policy, "mt-sm mt-dim"));
    lines.push(center(t.copy, "mt-xs mt-faint"));
    lines.push(center(t.printed, "mt-xs mt-faint"));
    lines.push(center(`${fmtDay(now)} ${fmtClock(now)} · magpie-token-receipt`, "mt-xs mt-faint"));
    lines.push(gap(6));

    const { placed, height } = layout(lines);
    const bandLine = placed.find((l) => l.k === "band");
    const stamp = o.stamp && sum && !p.error && bandLine ? { x: G + W * 0.55, y: bandLine.y + bandLine.h / 2 - 2, rx: 62, ry: 27 } : null;
    const inkY = placed.filter((l) => l.k === "row" || l.k === "center" || l.k === "kv2" || l.k === "barcode").map((l) => l.y);
    const ruleY = placed.filter((l) => l.k === "rule").map((l) => ({ top: l.y + RULE_INK, bottom: l.y + RULE_INK + (l.style === "thick" ? 2.4 : 1) }));
    return {
      svg: renderSvg(placed, height, { t, o, lang, stamp }),
      text: renderText(placed),
      width: W + G * 2,
      height,
      stats: { items: items.length, listed: listed.length, restCount, billTok, cacheTok, grandTok, listedTok, restTok, listedCost, restCost, freeItems, rows: placed.length },
      stamp,
      inkY,
      ruleY,
    };
  }

  const LEFT = G + PAD;
  const RIGHT = W + G - PAD;

  function renderSvg(placed, H, { t, o, lang, stamp }) {
    const amtX = RIGHT;
    const qtyX = amtX - (o.showCost ? QTY_COL : 0);
    const body = [];

    for (const ln of placed) {
      const y = ln.y.toFixed(1);
      if (ln.k === "rule") {
        const ry = (ln.y + RULE_INK).toFixed(1);
        const ry2 = (ln.y + RULE_INK + 2.4).toFixed(1);
        body.push(
          ln.style === "thick"
            ? `<path class="mt-rule mt-thick" d="M ${LEFT} ${ry} H ${amtX}"/><path class="mt-rule mt-hair" d="M ${LEFT} ${ry2} H ${amtX}"/>`
            : `<path class="mt-rule${ln.style === "dash" ? " mt-dash" : ""}" d="M ${LEFT} ${ry} H ${amtX}"/>`,
        );
        continue;
      }
      if (ln.k === "band") continue;
      if (ln.k === "barcode") {
        const bw = W - PAD * 2;
        body.push(`<g transform="translate(${LEFT} ${y})">${barcodeSvg(hash32(ln.digits), bw, 30)}</g>`);
        body.push(`<text class="mt-t mt-sm mt-spaced" x="${(LEFT + bw / 2).toFixed(1)}" y="${(ln.y + 41).toFixed(1)}" text-anchor="middle">${esc(ln.digits)}</text>`);
        continue;
      }
      if (ln.k === "center") {
        if (!ln.t) continue;
        body.push(`<text class="mt-t ${ln.cls}" x="${MID.toFixed(1)}" y="${y}" text-anchor="middle">${esc(ln.t)}</text>`);
        continue;
      }
      if (ln.k === "kv2") {
        body.push(
          `<text class="mt-t ${ln.cls} mt-dim" x="${LEFT}" y="${y}">${esc(ln.l1)}</text><text class="mt-t ${ln.cls}" x="168" y="${y}" text-anchor="end">${esc(ln.v1)}</text>` +
            `<text class="mt-t ${ln.cls} mt-dim" x="${(MID + 8).toFixed(1)}" y="${y}">${esc(ln.l2)}</text><text class="mt-t ${ln.cls}" x="${amtX}" y="${y}" text-anchor="end">${esc(ln.v2)}</text>`,
        );
        continue;
      }
      // row：左标题（可带 ×次数 的淡字），右两栏数字
      const attrs = ln.mark === "total" || ln.mark === "due" ? ` data-mt="${ln.mark}"` : "";
      if (ln.l) {
        const tip = ln.mark === "item" && ln.tip && ln.tip !== ln.l ? `<title>${esc(ln.tip)}</title>` : "";
        const suffix = ln.suffix ? `<tspan class="mt-xn" dx="3">${esc(ln.suffix)}</tspan>` : "";
        body.push(`<text class="mt-t ${ln.cls}" x="${LEFT}" y="${y}"${attrs}>${tip}${esc(ln.l)}${suffix}</text>`);
      }
      const big = ln.mark === "total" || ln.mark === "due";
      const pair = o.showCost && ln.vals.length > 1;
      ln.vals.forEach((v, i) => {
        if (v === "" || v == null) return;
        const x = big || (pair && i === ln.vals.length - 1) ? amtX : qtyX;
        const num = ln.mark === "total" ? "mt-num-xl" : ln.mark === "due" ? "mt-num-lg" : ln.cls.includes("mt-sm") ? "mt-num-sm" : "mt-num";
        body.push(`<text class="mt-t mt-r ${num}" x="${x.toFixed(1)}" y="${y}" text-anchor="end">${esc(v)}</text>`);
      });
    }

    const seal = stamp
      ? `<g class="mt-stamp" transform="translate(${stamp.x.toFixed(1)} ${stamp.y.toFixed(1)}) rotate(-9)">
<ellipse class="mt-stamp-o" rx="62" ry="27"/><ellipse class="mt-stamp-i" rx="55" ry="21"/>
<text class="mt-stamp-t" y="3">${esc(t.stamp)}</text><text class="mt-stamp-s" y="16">${esc(t.stampSub)} ${esc(fmtDay(new Date()))}</text></g>`
      : "";

    const paperCls = o.paper === "kraft" ? " mt-kraft" : o.paper === "aged" ? " mt-aged" : "";
    return `<svg class="mt-receipt${paperCls}${lang === "zh" ? " mt-zh" : " mt-en"}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + G * 2} ${H + G * 2}" width="${W + G * 2}" height="${H + G * 2}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="${esc(t.sub)}" font-family="ui-monospace, SFMono-Regular, Menlo, Cascadia Mono, Consolas, monospace">
<defs>
<linearGradient id="mt-sheen" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".07"/></linearGradient>
<linearGradient id="mt-feed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".07"/><stop offset=".06" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<filter id="mt-grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .06 0"/></filter>
<clipPath id="mt-clip"><path d="${paperPath(H)}"/></clipPath>
</defs>
<path class="mt-sheet" d="${paperPath(H)}"/>
<g clip-path="url(#mt-clip)"><rect x="${G}" y="${G - 6}" width="${W}" height="${H + 12}" fill="url(#mt-sheen)"/><rect x="${G}" y="${G}" width="${W}" height="${H}" fill="url(#mt-feed)"/><rect x="${G}" y="${G}" width="${W}" height="${H}" filter="url(#mt-grain)" opacity=".5"/><path class="mt-crease" d="M ${(G + W * 0.37).toFixed(1)} ${G} V ${(G + H).toFixed(1)}"/><path class="mt-crease" d="M ${(G + W * 0.72).toFixed(1)} ${G} V ${(G + H).toFixed(1)}"/></g>
<g class="mt-ink">${body.join("")}</g>${seal}
</svg>`;
  }

  function paperPath(h) {
    const zig = 4.5,
      step = 12;
    const x0 = G,
      x1 = G + W,
      y0 = G,
      y1 = G + h;
    let d = `M ${x0} ${y0}`;
    for (let x = x0; x < x1 - 0.1; x += step) d += ` L ${Math.min(x + step / 2, x1).toFixed(1)} ${(y0 - zig).toFixed(1)} L ${Math.min(x + step, x1).toFixed(1)} ${y0}`;
    d += ` L ${x1} ${y1}`;
    for (let x = x1; x > x0 + 0.1; x -= step) d += ` L ${Math.max(x - step / 2, x0).toFixed(1)} ${(y1 + zig).toFixed(1)} L ${Math.max(x - step, x0).toFixed(1)} ${y1}`;
    return `${d} Z`;
  }

  const COLS = 44; // 文本版网格宽
  const wide = (s) => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);

  // 文本版的条码：和 SVG 同一颗 hash，宽度铺满网格
  function textBars(seed) {
    let s = hash32(seed) >>> 0,
      out = "";
    while (out.length < COLS) {
      const bw = 1 + (s % 3),
        gp = 1 + ((s >> 5) % 2);
      out += "█".repeat(Math.min(bw, COLS - out.length)) + " ".repeat(Math.min(gp, COLS - out.length));
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    }
    return out.slice(0, COLS);
  }

  function renderText(placed) {
    const out = [];
    const center = (s) => out.push(" ".repeat(Math.max(0, Math.floor((COLS - wide(s)) / 2))) + s);
    for (const ln of placed) {
      if (ln.k === "gap") out.push("");
      else if (ln.k === "band") out.push("");
      else if (ln.k === "rule") out.push((ln.style === "thick" ? "=" : ln.style === "dash" ? "-" : "_").repeat(COLS));
      else if (ln.k === "center") ln.t && center(ln.t);
      else if (ln.k === "barcode") {
        out.push(textBars(ln.digits));
        center(ln.digits);
      } else if (ln.k === "kv2") {
        const a = `${ln.l1} ${ln.v1}`;
        const b = `${ln.l2} ${ln.v2}`;
        out.push(`${a.padEnd(20, " ")}${b}`.slice(0, COLS));
      } else if (ln.k === "row") {
        const right = ln.vals.filter((v) => v !== "" && v != null);
        const head = String(ln.l ?? "") + (ln.suffix ? " " + ln.suffix : "");
        if (!right.length) out.push(head);
        else {
          const tail = right.join("  ");
          const room = Math.max(1, COLS - wide(tail) - 1);
          out.push(head.slice(0, room).padEnd(room, ".") + " " + tail);
        }
      }
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  root.MagpieTokenReceipt = { buildReceipt, defaults, mergeItems, providerNames, fmtInt, fmtMoney, hash32, esc, STR, PAPER_W: W, PAD, G };
})(typeof globalThis !== "undefined" ? globalThis : window);
