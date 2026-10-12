// 开放阶段页的冒烟 + 截图:真 Chrome(无头)打开 index.html,接本地假服务(beta-phases-fake.mjs),
// 走一遍「读 → 改 → 拿码 → 写 → 重拉 → 留痕」,再截两张桌面宽(1280)的图。
//
//   HOME=$(mktemp -d) node tools/beta-phases-shot.mjs <输出目录> </dev/null 2>err.txt | cat
//
// ⚠️ 无头 Chrome 一律带 --use-mock-keychain --password-store=basic:临时 HOME 里找不到钥匙串时,
//    不带这两个会让 macOS 在屏幕上弹「找不到钥匙串」框。跑前跑后各 pgrep 一次 SecurityAgent / Keychain。
// ⛔ 只听 127.0.0.1;数据全是 example.com 与假计数;截图里没有真邮箱、真 token。
// 端口:两个假服务 8840 / 8841,Chrome 调试口 8842(PH_PORT_BASE 可改基数)。
// SEC-M8 之后:页面 CSP 不放 unsafe-inline,按钮走 data-click 委托 —— 这里点按钮都是真点(走委托),
//   并在每个新文档开头挂 securitypolicyviolation 监听 + 收控制台,最后核「CSP 拦截 0 次」「data-style 全套上」。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFake, servePage } from "./beta-phases-fake.mjs";

const OUT = process.argv[2];
if (!OUT) { console.error("用法:node tools/beta-phases-shot.mjs <输出目录>"); process.exit(2); }
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1280;
const PORT_BASE = Number(process.env.PH_PORT_BASE || 8840);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const check = (ok, label) => { console.log((ok ? "PASS  " : "FAIL  ") + label); if (!ok) bad++; };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "phshot-"));
const chrome = spawn(CHROME, ["--headless=new", "--use-mock-keychain", "--password-store=basic",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + (PORT_BASE + 2), "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--window-size=" + W + ",900", "about:blank"],
  { stdio: ["ignore", "ignore", "ignore"] });

async function devtoolsPort() {
  // 固定调试口时新版 Chrome 不一定写 DevToolsActivePort —— 直接轮询 /json/version(只听 127.0.0.1)
  const port = PORT_BASE + 2;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); if (r.ok) return port; } catch (e) {}
    await sleep(100);
  }
  throw new Error("Chrome 没起来(15 秒内调试口 " + port + " 没应答)");
}

// 极小的 CDP 客户端
async function cdp(port) {
  const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { const [r, j] = wait.get(d.id); wait.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result); }
    // 兜底:页面要是真弹了 confirm,一律点「确定」(正常情况下页面里的 confirm 已被换掉)
    if (d.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
    if (d.method && api.onEvent) api.onEvent(d);
  };
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++id; wait.set(i, [r, j]); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("页面里抛错:" + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const until = async (expr, label, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(100); }
    throw new Error("等不到:" + label);
  };
  const api = { send, ev, until, close: () => ws.close(), onEvent: null };
  return api;
}

async function shoot(c, file) {
  const box = await c.ev("(function () { var a = document.getElementById('access').getBoundingClientRect(), b = document.getElementById('phSec').getBoundingClientRect();" +
                        " return { y: a.top + window.scrollY - 8, h: b.bottom - a.top + 16 }; })()");
  const r = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
                                                     clip: { x: 0, y: Math.max(0, box.y), width: W, height: Math.ceil(box.h), scale: 1 } });
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  return { file, h: Math.ceil(box.h) };
}

// 在页面里改一格并触发 oninput / onchange,和人敲的走同一条路
const type = (id, v) => "(function () { var e = document.getElementById(" + JSON.stringify(id) + "); e.value = " + JSON.stringify(v) +
  "; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()";
const click = (id) => "(function () { document.getElementById(" + JSON.stringify(id) + ").click(); return true; })()";
const html = (id) => "document.getElementById(" + JSON.stringify(id) + ").innerHTML";

let srv1, srv2, c;
const consoleErrs = [], netLogs = [];
const cspCheck = async (label) => {
  const v = await c.ev("window.__csp || ['__csp 没挂上']");
  check(v.length === 0, label + ":CSP 拦截 0 次" + (v.length ? "(" + v.slice(0, 3).join(" | ") + ")" : ""));
  const st = await c.ev("(function () { var l = document.querySelectorAll('[data-style]'), n = 0; for (var i = 0; i < l.length; i++) if (!l[i].style.cssText) n++; return [l.length, n]; })()");
  check(st[0] > 0 && st[1] === 0, label + ":data-style 共 " + st[0] + " 处、没套上的 " + st[1] + " 处");
};
try {
  fs.mkdirSync(OUT, { recursive: true });
  const port = await devtoolsPort();
  c = await cdp(port);
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Log.enable");
  // CSP 拦截:页面事件 + 控制台两路都收(addScriptToEvaluateOnNewDocument 不受页面 CSP 管)
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source:
    "window.__csp = []; document.addEventListener('securitypolicyviolation', function (e) { window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')); });" });
  c.onEvent = (d) => {
    const t = d.method === "Log.entryAdded" ? d.params.entry.text : d.method === "Runtime.consoleAPICalled" ? (d.params.args || []).map((a) => a.value).join(" ") :
              d.method === "Runtime.exceptionThrown" ? "EXC " + (d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || d.params.exceptionDetails.text) : null;
    if (t == null) return;
    // 假服务按契约回的 403 / 404(不是管理员的 /admin/config、没有的路由)是网络层日志,单独记一行,不算页面报错
    if (d.params.entry && d.params.entry.source === "network") { netLogs.push(d.params.entry.url + " " + t); return; }
    if (/Content Security Policy|EXC /.test(t) || (d.params.entry && d.params.entry.level === "error") || d.params.type === "error") consoleErrs.push(t);
  };
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 1, mobile: false });

  // ── 场景一:上线当天(内测、自动放行关)→ 改内测上限 + 加一个 staff → 留痕 ─────────
  const f1 = createFake("closed");
  srv1 = await servePage(f1, PORT_BASE);
  await c.send("Page.navigate", { url: "http://127.0.0.1:" + srv1.address().port + "/" });
  await c.until("!!document.getElementById('phBody') && !document.getElementById('phBody').classList.contains('hidden')", "开放阶段块出现");
  await c.ev("window.confirm = function () { return true; }; true");
  check((await c.ev(html("phSummary"))).includes("4 / 20"), "读:顶部现状 内测 4 / 20");
  check(await c.ev("document.getElementById('ph_caps_apply').disabled"), "读:没改 →「应用」是灰的");

  await c.ev(type("phIn_closed_cap", "30"));
  const diff1 = await c.ev(html("ph_caps_diff"));
  check(diff1.includes("内测上限 20 → 30") && diff1.includes("内测阶段还能手动开 16 → 26 个"), "改:先摆「内测上限 20 → 30」+ 影响「还能手动开 16 → 26 个」");
  await c.ev(type("phIn_closed_cap", "-3"));
  check((await c.ev(html("phIn_closed_cap_msg"))).includes("0–100000") && await c.ev("document.getElementById('ph_caps_apply').disabled"), "越界:-3 → 红字写 0–100000、应用变灰");
  await c.ev(type("phIn_closed_cap", "30"));
  await c.ev(click("ph_caps_apply"));
  await c.until(html("phAudit") + ".indexOf('内测上限 20 → 30') >= 0", "留痕出现 内测上限 20 → 30");
  check(f1.state.settings.closed_cap === 30, "写:假服务里 closed_cap = 30(码一次性、绑动作 + 参数,核过)");
  check((await c.ev(html("phSummary"))).includes("4 / 30"), "重拉:顶部现状变成 4 / 30");

  await c.ev(type("phStaffEmail", "ops@example.com"));
  await c.ev("document.querySelector('#phBody button[data-click=\"phStaffAdd\"]').click(); true");
  await c.until(html("phStaff") + ".indexOf('ops@example.com') >= 0", "staff 名单出现 ops@example.com");
  const writes = f1.log.filter((x) => x.path === "/admin/action" && x.action !== "access_get");
  check(writes.length === 2 && writes.every((x) => x.status === 200 && x.confirm) && writes[0].confirm !== writes[1].confirm, "两个写各带一个不同的确认码,都 200");
  // 页面状态与消息停在「刚改完」那一刻,再截
  await c.ev(type("phIn_public_cap", "150"));
  await cspCheck("场景一");
  const s1 = await shoot(c, path.join(OUT, "1-closed-after-write.png"));
  console.log("截图 " + s1.file + "(" + W + "×" + s1.h + ")");

  // ── 场景二:公测满额、20 人候补、自动放行开 → 预览「公测上限 100 → 300」的影响 ──────
  const f2 = createFake("public");
  srv2 = await servePage(f2, PORT_BASE + 1);
  await c.send("Page.navigate", { url: "http://127.0.0.1:" + srv2.address().port + "/" });
  await c.until("!!document.getElementById('phBody') && !document.getElementById('phBody').classList.contains('hidden') && document.getElementById('accessFilters').innerHTML.length > 0", "公测场景加载完");
  await c.ev("window.confirm = function () { return true; }; true");
  // 真点「候补」那颗筛选(走 data-click + data-args 委托,不直接调函数)
  await c.ev("(function () { var b = Array.prototype.filter.call(document.querySelectorAll('#accessFilters button'), function (x) { return x.textContent === '候补'; })[0]; b.click(); return true; })()");
  check(await c.ev("(document.querySelector('#accessFilters button.on') || {}).textContent === '候补'"), "点「候补」筛选:按钮变选中态(委托分派生效)");
  check((await c.ev(html("accessTable"))).includes("入队") && (await c.ev(html("accessCount"))).includes("候补 20"), "申请名额栏:候补筛选 + 候补 20");
  await c.ev(type("phIn_public_cap", "300"));
  const diff2 = await c.ev(html("ph_caps_diff"));
  check(diff2.includes("公测上限 100 → 300") && diff2.includes("候补里前 20 人可以放行") && diff2.includes("下一批放 10 人"),
        "影响一句:公测上限 100 → 300 → 候补里前 20 人可以放行,下一批放 10 人");
  check(f2.log.filter((x) => x.path === "/admin/action" && x.action !== "access_get").length === 0, "只是预览:一发写都没有");
  await cspCheck("场景二");
  const s2 = await shoot(c, path.join(OUT, "2-public-preview.png"));
  console.log("截图 " + s2.file + "(" + W + "×" + s2.h + ")");
} catch (e) {
  console.log("FAIL  冒烟没跑完:" + e.message);
  bad++;
} finally {
  try { c && c.close(); } catch (e) {}
  try { srv1 && srv1.close(); srv2 && srv2.close(); } catch (e) {}
  chrome.kill("SIGTERM");
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
if (netLogs.length) console.log("网络层(假服务按契约回的非 2xx,不算报错):" + Array.from(new Set(netLogs.map((x) => x.replace(/^https?:\/\/127\.0\.0\.1:\d+/, "")))).join(" | "));
check(consoleErrs.length === 0, "控制台无 CSP 报错 / 未捕获异常 / error 级日志" + (consoleErrs.length ? "(" + consoleErrs.slice(0, 3).join(" | ") + ")" : ""));
console.log(bad ? "✗ " + bad + " 条没过" : "✓ 冒烟全过");
process.exit(bad ? 1 : 0);
