import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// receipt.js 是给沙箱页用的经典脚本（type="module" 在 magpie 的沙箱里取不到，见 receipt.js 顶上）。
// 测试按浏览器同样的方式求值它，再取它挂到 globalThis 上的一组函数 —— 顺带钉住"它不能出现 import/export"。
(0, eval)(readFileSync(new URL("../page/receipt.js", import.meta.url), "utf8"));
const { buildReceipt, mergeItems, providerNames, fmtMoney, esc, defaults } = globalThis.MagpieTokenReceipt;

// fixture-usage.json 是从 magpie 真实代码路径里抓下来的 usage:summary 原样返回
// （沙箱实例 + 合成 usage.jsonl，字段与数值都由 magpie 自己算出来）
const fx = JSON.parse(readFileSync(new URL("./fixture-usage.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-05T17:22:31");
const build = (summary, options = {}, extra = {}) =>
  buildReceipt({ summary, providers: [], now: NOW, options: { ...defaults, ...options }, ...extra });

test("票面列示与合计平账：列出的加「其他」正好等于输入+输出", () => {
  const r = build(fx.today, { top: 3 });
  assert.equal(r.stats.listedTok + r.stats.restTok, fx.today.input + fx.today.output);
  assert.equal(r.stats.grandTok, fx.today.input + fx.today.output + fx.today.cacheRead);
  assert.ok(Math.abs(r.stats.listedCost + r.stats.restCost - fx.today.cost) < 1e-9);
  assert.ok(r.stats.restTok > 0, "top=3 时应该出现「其他」一行");
});

test("条目没被截断时不虚构「其他」一行", () => {
  // magpie 给的 models 覆盖全部用量（fixture 里 sum(models) == 合计），所以余额为 0
  const r = build(fx.today, { top: 0 });
  assert.equal(r.stats.restTok, 0);
  assert.equal(r.stats.restCount, 0);
  assert.doesNotMatch(r.svg, /其他|缓存与其他|Other items|cache & rounding/);
});

test("同一模型名走多个供应商时合并成一件商品，并在名字后标 ×次数", () => {
  // 16 条 models 里只有 8 个不同名字，这是 magpie 的真实形状（fixture 里的名字与时区已通用化）
  const merged = mergeItems(fx.today.models);
  assert.equal(merged.length, 8);
  const dup = merged.find((m) => m.name === "model-zeta");
  assert.ok(dup, "fixture 里该有重名的模型");
  assert.equal(dup.hosts, 2);
  assert.equal(
    dup.calls,
    fx.today.models.filter((m) => m.model === "model-zeta").reduce((a, m) => a + m.calls, 0),
  );
  const r = build(fx.today, { top: 0 });
  assert.equal(r.svg.split(">model-zeta<tspan").length - 1, 1, "票面上同一个名字只印一次");
  assert.ok(r.svg.includes(`×${dup.calls}`), "合并后的笔数写在名字后面");
});

test("同样的用量永远打出同一张票（票号、条码、条宽都来自 hash）", () => {
  const a = build(fx.today);
  const b = build(fx.today, { period: "today" });
  assert.equal(a.svg, b.svg);
  assert.notEqual(a.text, "");
  assert.notEqual(build(fx.d7).svg, a.svg, "换了时段就该是另一张票");
});

test("模型名里的 HTML 被转义，不会当成标记画进票里", () => {
  const evil = {
    ...fx.today,
    models: [{ model: '<script>alert(1)</script> & “x”', calls: 1, input: 10, output: 5, cost: 0 }],
  };
  const r = build(evil, { top: 0 });
  assert.ok(!r.svg.includes("<script"), "原始 <script 不能出现");
  assert.ok(r.svg.includes("&lt;script&gt;"), "应转义后显示");
  assert.ok(!r.svg.includes('alert(1)</script>'), "也不该被任何形式还原");
});

test("读取失败时画故障票，不画 NaN 也不崩", () => {
  const r = buildReceipt({ summary: null, error: 'no period "hour": today, 7d or 30d', now: NOW, options: defaults, providers: [] });
  assert.ok(!/NaN|undefined/.test(r.svg), "票面不该出现 NaN/undefined");
  assert.match(r.svg, /打印失败|PRINT FAILED/);
  assert.match(r.svg, /no period/);
});

test("空 models 也画得出来（今天还没用过）", () => {
  const empty = { period: "today", since: "2026-11-05T00:00:00+00:00", calls: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cost: 0, models: [] };
  const r = build(empty);
  assert.match(r.svg, /本时段还没有用量|no usage in this window/);
  assert.equal(r.stats.grandTok, 0);
  assert.ok(r.height >= 320);
});

test("缺字段的老返回（没有 errors / cacheRead）不炸", () => {
  const thin = { period: "today", calls: 2, input: 100, output: 20, cost: 0, models: [{ model: "a", calls: 2, input: 100, output: 20 }] };
  const r = build(thin, { top: 0 });
  assert.equal(r.stats.grandTok, 120);
  assert.ok(!/NaN/.test(r.svg));
});

test("showCost 关掉就整列不画，合计行也不留孤零零的 $", () => {
  const on = build(fx.today, { top: 4 });
  const off = build(fx.today, { top: 4, showCost: false });
  assert.match(on.svg, /金额|AMT/);
  assert.doesNotMatch(off.svg, /金额|AMT\(/);
  assert.doesNotMatch(off.svg, /\$ 0\.0000|\$ 0\./);
  assert.ok(off.height <= on.height + 40, "少一列不该把票拉得更高");
});

test("零元项写成「免费/free」而不是 0.0000", () => {
  const free = { ...fx.today, models: [{ model: "free-model", calls: 3, input: 1000, output: 100, cost: 0 }] };
  const r = build(free, { top: 0 });
  assert.match(r.svg, />免费<|>free</);
  assert.ok(!/0\.0000/.test(r.svg.split("合计 TOKENS")[0]), "商品行里不该出现 0.0000");
  assert.equal(r.stats.freeItems, 1);
});

test("窗口语言决定票面语言，显式 lang 覆盖它", () => {
  assert.match(build(fx.today, {}, { windowLang: "zh-CN" }).svg, /合计 TOKENS/);
  assert.match(build(fx.today, {}, { windowLang: "en" }).svg, /TOTAL TOKENS/);
  assert.match(build(fx.today, { lang: "en" }, { windowLang: "zh-CN" }).svg, /TOTAL TOKENS/);
});

test("providers:list 的几种可能形状都取得到名字", () => {
  assert.deepEqual(providerNames(["a", "b"]), ["a", "b"]);
  assert.deepEqual(providerNames([{ name: "Acme" }, { id: "z" }]), ["Acme", "z"]);
  assert.deepEqual(providerNames({ providers: [{ label: "L" }] }), ["L"]);
  assert.deepEqual(providerNames({ data: [{ title: "T" }] }), ["T"]);
  assert.deepEqual(providerNames(undefined), []);
  assert.deepEqual(providerNames([{ nope: 1 }]), []);
  const zh = buildReceipt({ summary: fx.today, providers: [{ name: "ZCode" }, { name: "Qoder" }], now: NOW, options: defaults, windowLang: "zh-CN" });
  assert.match(zh.svg, /本店经营 2 家供应商/);
  assert.match(zh.svg, /ZCode、Qoder/);
  const en = buildReceipt({ summary: fx.today, providers: ["ZCode", "Qoder"], now: NOW, options: defaults, windowLang: "en" });
  assert.match(en.svg, /COUNTER SERVES 2 providers/);
});

test("票跟着行数长高，纸不会盖住字", () => {
  const many = {
    ...fx.today,
    models: Array.from({ length: 20 }, (_, i) => ({ model: `model-${i}-${"x".repeat(20)}`, calls: i + 1, input: 5000 - i * 100, output: 500, cost: 0.01 * i })),
  };
  const short = build(many, { top: 2 });
  const tall = build(many, { top: 0 });
  assert.ok(tall.height > short.height + 100, "多印 18 行该明显变长");
  assert.equal(tall.width, 372);
});

test("fmtMoney 小钱留四位、大钱收成整数，0 交给「免费」", () => {
  assert.equal(fmtMoney(0.20040419403), "0.2004");
  assert.equal(fmtMoney(123.456), "123.46");
  assert.equal(fmtMoney(1234.5), "1235");
  assert.equal(fmtMoney(0), null);
});

test("文本版和票同一颗 hash，可直接复制到聊天里", () => {
  const r = build(fx.today, { top: 5 });
  assert.match(r.text, /-{5,}|={5,}/);
  assert.ok(r.text.split("\n").length > 25);
  assert.ok(!/NaN/.test(r.text));
  assert.equal(esc(undefined), "");
});

test("红章只盖在留出的空白带上，不压任何一行字", () => {
  const r = build(fx.today, { top: 4 });
  assert.ok(r.stamp, "默认该有章");
  const top = r.stamp.y - r.stamp.ry;
  const bottom = r.stamp.y + r.stamp.ry;
  assert.deepEqual(r.inkY.filter((y) => y > top - 2 && y < bottom + 2), [], "章的竖直范围内不该有任何文字基线");
  assert.equal(build(fx.today, { stamp: false }).stamp, null, "关掉就不画");
  assert.equal(build(null, {}, { error: "boom" }).stamp, null, "故障票不盖章");
});

test("元信息两栏并排，票号与终端不再各占一行", () => {
  const r = build(fx.today);
  assert.match(r.svg, /x="168" y="[\d.]+" text-anchor="end">T-\d+/);
  assert.match(r.svg, /RECEIPT NO|票号/);
  const lines = r.text.split("\n");
  assert.ok(lines.some((l) => /TERM\s+T-\d+\s+RECEIPT NO/.test(l)), "文本版同一行给两组");
});

test("分隔线绝不穿字：每条线上下都留得下一行的身位", () => {
  // 基线落在线下方 10px 内会被上伸部撞上，落在线上方 3px 内会被降部压住
  for (const opts of [{ top: 4 }, { top: 0, showCost: false }, { lang: "en" }, { top: 20 }]) {
    const r = build(fx.today, opts);
    assert.ok(r.ruleY.length >= 5, "该有至少五条线");
    for (const line of r.ruleY) {
      assert.deepEqual(r.inkY.filter((y) => y > line.top - 3 && y < line.bottom + 10), [], `线 ${JSON.stringify(line)} 穿到了字`);
    }
  }
});
