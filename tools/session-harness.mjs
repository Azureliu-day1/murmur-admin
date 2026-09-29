// 管理后台会话续期的定向哨兵。
// 把 index.html 里那段 <script> 抽出来,喂给一个极小的假 DOM + 假 fetch,
// 记录调用顺序 —— 要证明的东西全在「谁先被打、带的是哪张 token」里。
import fs from "node:fs";
import vm from "node:vm";

const HTML = fs.readFileSync(process.argv[2] || "index.html", "utf8");
const m = HTML.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error("没找到 <script> 块"); process.exit(1); }
const CODE = m[1];
fs.writeFileSync("/tmp/murmur-admin-harness-extracted.js", CODE);

const TOK = "https://syebvkwemxwxkonvsyjd.supabase.co/auth/v1/token";
const STATS = "/admin/stats", ACC = "/admin/access-requests";

function makeEl(id) {
  const el = {
    id, innerHTML: "", textContent: "", className: "", value: "",
    clientWidth: 600, style: {}, _cls: new Set(),
    classList: {
      add: (...c) => c.forEach(x => el._cls.add(x)),
      remove: (...c) => c.forEach(x => el._cls.delete(x)),
      contains: c => el._cls.has(c),
    },
    getAttribute: () => null, setAttribute: () => {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 150 }),
    addEventListener: () => {},
  };
  return el;
}

function run(name, { session, serverExpired, statsAlways401, refreshFails, retryStill401 }) {
  const log = [];
  const store = new Map();
  if (session) store.set("murmur.admin.session", JSON.stringify(session));
  const els = new Map();
  const $ = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

  let refreshes = 0, gen = 0;          // gen = 服务端认的「当前这一代 token」
  let liveToken = serverExpired ? "__none__" : (session && session.access_token);

  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

  function fetchStub(url, init = {}) {
    const method = init.method || "GET";
    const auth = (init.headers || {}).Authorization;
    const tok = auth ? String(auth).replace("Bearer ", "") : null;
    const short = url.replace("https://syebvkwemxwxkonvsyjd.supabase.co/functions/v1/murmur", "").replace(TOK, "TOKEN");

    if (url.startsWith(TOK)) {
      refreshes++;
      const sent = JSON.parse(init.body).refresh_token;
      log.push(`${method} ${short.split("?")[0]}?grant_type=refresh_token   送出 refresh=${sent}`);
      if (refreshFails) { log.push("      ← 400 (refresh_token 也废了)"); return Promise.resolve(res(400, { error: "invalid_grant" })); }
      gen++;
      liveToken = "ACCESS_v" + gen;
      const fresh = { access_token: liveToken, refresh_token: "REFRESH_v" + gen, token_type: "bearer", expires_in: 3600 };
      log.push(`      ← 200 新 access=${fresh.access_token} 新 refresh=${fresh.refresh_token}`);
      return Promise.resolve(res(200, fresh));
    }

    const ok401 = statsAlways401 || (retryStill401 ? true : tok !== liveToken);
    if (ok401) {
      log.push(`${method} ${short}   Bearer ${tok}  ← 401`);
      return Promise.resolve(res(401, { error: { message: "JWT expired" } }));
    }
    log.push(`${method} ${short}   Bearer ${tok}  ← 200`);
    if (short.indexOf(STATS) >= 0) {
      return Promise.resolve(res(200, {
        admin: "admin@example.com", server_time: "2026-09-17T23:59:00Z",
        overview: {}, users: [], anomalies: [], plans: [], audit: [], invites: [],
        daily: [], features: [], feature_totals: [], apis: {},
      }));
    }
    if (short.indexOf(ACC) >= 0) return Promise.resolve(res(200, { requests: [], counts: {} }));
    return Promise.resolve(res(200, {}));
  }

  const win = {
    HOST: undefined, addEventListener: () => {}, setTimeout, clearTimeout,
    Promise, JSON, Math, Date, Number, String, Object, Array, isNaN, console, encodeURIComponent,
    fetch: fetchStub,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k),
    },
    location: { reload: () => log.push("location.reload()") },
    prompt: () => null, alert: () => {},
    document: {
      getElementById: $, querySelectorAll: () => [], addEventListener: () => {},
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(CODE, win, { filename: "admin.js" });

  return new Promise(resolve => {
    let ticks = 0;
    const drain = () => (++ticks > 40 ? finish() : setTimeout(drain, 0));
    const finish = () => {
      const saved = store.get("murmur.admin.session");
      resolve({ name, log, refreshes,
        gateShown: $("gate")._cls.has("hidden") === false,
        mainHidden: $("main")._cls.has("hidden"),
        saved: saved ? JSON.parse(saved) : null });
    };
    drain();
  });
}

const LIVE = { access_token: "ACCESS_v0", refresh_token: "REFRESH_v0", expires_at: Math.floor(Date.now()/1000) + 3600 };
const DEAD = { access_token: "ACCESS_v0", refresh_token: "REFRESH_v0", expires_at: Math.floor(Date.now()/1000) - 60 };
const NOEXP = { access_token: "ACCESS_v0", refresh_token: "REFRESH_v0" };   // 旧版页面存下的形状

const CASES = [
  ["a) 没过期 —— 正常进,一次 refresh 都不该打", { session: LIVE }],
  ["b) expires_at 已过 —— 先续再拉,新 refresh 要落盘", { session: DEAD, serverExpired: true }],
  ["c) refresh 也 401 —— 回登录页", { session: DEAD, serverExpired: true, refreshFails: true }],
  ["d) 会话看着没过期、服务端两条路同时 401 —— 只许续一次,然后各重试一次", { session: LIVE, statsAlways401: false, serverExpired: true }],
  ["e) 续成功了、重试还 401 —— 不许无限重试,回登录页", { session: LIVE, retryStill401: true }],
  // 升级路径:Wei 浏览器里**现在**躺着的那份 session 是旧版页面存的。
  // 万一它没有 expires_at,boot() 的提前续期就不会触发 —— 那时只能靠 401 那条路兜底。
  ["f) 老版本存的会话(没有 expires_at)、已经过期 —— 401 兜底也要能续回来", { session: NOEXP, serverExpired: true }],
];

// ⚠️ 2026-09-29 起 load() 并行拉**三**条管理员路由(stats / access-requests / 新加的 config)。
//    下面这些「几次 200 / 几次 401」的断言原本数的是全部业务请求,当时只有两条;
//    它们要证的是「stats 和 access 这两条各自挨一次、各自重试一次」,所以现在只数这两条 ——
//    第三条的存在不改变单飞续期的结论(三条同时 401 也只续一次,refresh 次数那条断言照旧)。
const two = l => l.includes(STATS) || l.includes(ACC);

const EXPECT = {
  "a": r => [[r.refreshes === 0, "refresh 次数 = 0"],
             [r.log.filter(l => two(l) && l.includes("← 200")).length === 2, "stats + access 各一次 200"],
             [!r.mainHidden, "主体可见"]],
  "b": r => [[r.refreshes === 1, "refresh 恰好 1 次"],
             [r.log[0].includes("grant_type=refresh_token"), "refresh 排在所有数据请求**之前**"],
             [r.saved && r.saved.refresh_token === "REFRESH_v1", "新 refresh_token 已落盘(rotation)"],
             [r.saved && r.saved.expires_at > Math.floor(Date.now()/1000), "expires_at 已补算"],
             [!r.mainHidden, "主体可见"]],
  "c": r => [[r.refreshes === 1, "refresh 恰好 1 次"],
             [!r.log.some(l => l.includes("/admin/")), "没有拿废 token 去打业务路由"],
             [r.saved === null, "会话已清"],
             [r.gateShown && r.mainHidden, "回到登录页"]],
  "d": r => [[r.refreshes === 1, "两条路同时 401,refresh 只打了 1 次(单飞)"],
             [r.log.filter(l => two(l) && l.includes("← 401")).length === 2, "两条各挨一个 401"],
             [r.log.filter(l => two(l) && l.includes("Bearer ACCESS_v1") && l.includes("← 200")).length === 2, "两条都用新 token 重试成功"],
             [!r.mainHidden, "主体可见"]],
  "f": r => [[r.refreshes === 1, "refresh 恰好 1 次"],
             [r.log.filter(l => two(l) && l.includes("← 401")).length === 2, "先各挨一个 401(没有提前续期,因为不知道到期时刻)"],
             [r.saved && r.saved.expires_at, "续回来之后补上了 expires_at —— 下次就走提前续期了"],
             [!r.mainHidden, "主体可见:人没有被踢回登录页"]],
  "e": r => [[r.refreshes === 1, "refresh 只打 1 次"],
             [r.log.filter(l => l.includes(STATS)).length === 2, "stats 只发了 2 次(原始 + 重试一次),没有无限重试"],
             [r.saved === null, "会话已清"],
             [r.gateShown && r.mainHidden, "回到登录页"]],
};

let bad = 0;
for (const [name, cfg] of CASES) {
  const r = await run(name, cfg);
  console.log("\n══ " + name);
  r.log.forEach((l, i) => console.log("   " + String(i + 1).padStart(2) + ". " + l));
  console.log("   —— gate=" + (r.gateShown ? "显示" : "隐藏") + "  main=" + (r.mainHidden ? "隐藏" : "显示") +
              "  refresh 次数=" + r.refreshes + "  存下的 refresh_token=" + (r.saved ? r.saved.refresh_token : "(无会话)"));
  for (const [pass, label] of EXPECT[name[0]](r)) {
    console.log("   " + (pass ? "PASS" : "FAIL") + "  " + label);
    if (!pass) bad++;
  }
}

// ════════════════════════════════════════════════════════════════════
// 配置块(2026-09-29):模型与供应商 / 密钥 / 单价 / 回退。
// 同一份抽出来的 <script>,另起一个假世界:假 fetch 按路径回包,把每一发请求
// (URL、方法、请求体)和 console 输出都记下来 —— 要证的是「什么时候**没有**发」
// 和「key 最后**不在**哪儿」。
// ⛔ 夹具里不写任何像真 key 的字面量(公开仓推送前扫描会拦);测试用的「key」在运行时现拼,
//    只用 g–z 字母(不是十六进制),长度 40。
// ════════════════════════════════════════════════════════════════════
const API_PREFIX = "https://syebvkwemxwxkonvsyjd.supabase.co/functions/v1/murmur";
const fakeKey = () => Array.from({ length: 40 }, () => "ghijkmnpqrstuvwxyz"[Math.floor(Math.random() * 18)]).join("");
const T0 = "2026-09-29T05:00:00Z";

function cfgFixture(extra) {
  return Object.assign({
    providers: [
      { id: "deepseek", kind: "llm", display_name: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions",
        dialect: "deepseek", key_name: "DEEPSEEK_API_KEY", default_params: {}, strip_params: [], enabled: true, updated_at: T0 },
      { id: "openrouter", kind: "llm", display_name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions",
        dialect: "openai", key_name: "OPENROUTER_API_KEY", default_params: {}, strip_params: ["thinking", "reasoning_effort"], enabled: true, updated_at: T0 },
      { id: "soniox", kind: "asr", display_name: "Soniox", endpoint: "https://api.soniox.com/v1/auth/temporary-api-key",
        dialect: null, key_name: "SONIOX_API_KEY", default_params: {}, strip_params: [], enabled: true, updated_at: T0 },
    ],
    models: { fast: { provider_id: "deepseek", model_id: "deepseek-v4-flash", updated_at: T0 },
              smart: { provider_id: "deepseek", model_id: "deepseek-v4-flash", updated_at: T0 } },
    pricing: { asr_rt_micros_per_second: { micros_per_unit: 55, note: "实测", updated_at: T0 },
               llm_flash_in_per_mtok: 220000, llm_flash_out_per_mtok: 660000 },
    keys: [{ name: "DEEPSEEK_API_KEY", last4: "k9Qz", len: 35, sha8: "0a1b2c3d", updated_at: T0 },
           { name: "OPENROUTER_API_KEY", last4: "m2Wx", len: 73, sha8: "4e5f6a7b", updated_at: T0 },
           { name: "SONIOX_API_KEY", last4: "p7Rt", len: 64, sha8: "8c9d0e1f", updated_at: T0 }],
    versions: { config_version: 7 },
    audit: [
      // 形状照服务端 GET /admin/config 的 audit:数字 id、actor_email、created_at,没有 target 列(对象在快照里)
      { id: 11, created_at: T0, actor_email: "admin@example.com", action: "config.model", reason: null,
        before: { kind: "model", tier: "smart", provider_id: "deepseek", model_id: "deepseek-v4-flash" },
        after: { kind: "model", tier: "smart", provider_id: "openrouter", model_id: "x/y" } },
      { id: 12, created_at: T0, actor_email: "admin@example.com", action: "config.key", reason: null,
        before: { kind: "key", name: "SONIOX_API_KEY", last4: "p7Rt", sha8: "8c9d0e1f" },
        after: { kind: "key", name: "SONIOX_API_KEY", last4: "n3Vb", sha8: "2a3b4c5d" } },
      { id: 13, created_at: T0, actor_email: "admin@example.com", action: "config.probe", reason: null,
        before: null, after: { kind: "llm", provider_id: "deepseek", ok: true, latency_ms: 300 } },
    ],
  }, extra || {});
}

async function cfgWorld(routes, opt = {}) {
  const els = new Map();
  const $ = id => { if (!els.has(id)) { const e = makeEl(id); e.disabled = undefined; e.checked = false; els.set(id, e); } return els.get(id); };
  const store = new Map([["murmur.admin.session", JSON.stringify(LIVE)]]);
  const reqs = [], out = [], confirms = [];
  const st = { confirm: opt.confirm !== false };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  function fetchStub(url, init = {}) {
    const path = url.replace(API_PREFIX, "").split("?")[0];
    reqs.push({ url, path, method: init.method || "GET", body: init.body == null ? null : String(init.body) });
    if (path === "/admin/stats") return Promise.resolve(res(200, { admin: "admin@example.com", server_time: T0, overview: {}, users: [],
      anomalies: [], plans: [], audit: [], invites: [], daily: [], features: [], feature_totals: [], apis: {} }));
    if (path === "/admin/access-requests") return Promise.resolve(res(200, { requests: [], counts: {} }));
    const h = routes[path];
    if (!h) return Promise.resolve(res(404, { error: { message: "no route" } }));
    const [code, body] = h(init.body ? JSON.parse(init.body) : null);
    return Promise.resolve(res(code, body));
  }
  const cons = { log: (...a) => out.push(a.join(" ")), error: (...a) => out.push(a.join(" ")),
                 warn: (...a) => out.push(a.join(" ")), info: (...a) => out.push(a.join(" ")) };
  const win = {
    addEventListener: () => {}, setTimeout, clearTimeout,
    Promise, JSON, Math, Date, Number, String, Object, Array, isNaN, isFinite, RegExp, console: cons, encodeURIComponent,
    fetch: fetchStub,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: { reload: () => {}, href: "https://example.com/murmur-admin/" },
    prompt: () => null, alert: m => out.push("alert " + m),
    confirm: m => { confirms.push(m); return st.confirm; },
    document: { getElementById: $, querySelectorAll: () => [], addEventListener: () => {} },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(CODE, win, { filename: "admin.js" });
  const drain = () => new Promise(r => { let n = 0; const t = () => (++n > 40 ? r() : setTimeout(t, 0)); t(); });
  await drain();
  const call = async (fn, ...args) => {
    if (typeof win[fn] !== "function") { out.push("MISSING " + fn); return; }
    win[fn](...args); await drain();
  };
  return { win, $, els, store, reqs, out, confirms, st, drain, call,
           posts: p => reqs.filter(r => r.path === p && r.method === "POST") };
}

// 在全局变量里深搜一个串(跳过函数与宿主对象,防环)
function deepHas(root, needle) {
  const seen = new Set();
  const skip = new Set(["window", "document", "localStorage", "fetch", "console", "location", "Promise", "JSON", "Math",
                        "Date", "Number", "String", "Object", "Array", "RegExp", "setTimeout", "clearTimeout"]);
  function walk(v, d) {
    if (v == null || d > 6) return false;
    if (typeof v === "string") return v.includes(needle);
    if (typeof v !== "object") return false;
    if (seen.has(v)) return false; seen.add(v);
    for (const k of Object.keys(v)) { if (d === 0 && skip.has(k)) continue; if (walk(v[k], d + 1)) return true; }
    return false;
  }
  return walk(root, 0);
}
const domHas = (w, needle) => [...w.els.values()].some(e =>
  [e.value, e.innerHTML, e.textContent].some(x => typeof x === "string" && x.includes(needle)));
const hidden = (w, id) => w.$(id)._cls.has("hidden");

const CFG_CASES = [
  ["g) 非管理员:/admin/config 回 403 —— 配置块整块不出现", async () => {
    const w = await cfgWorld({ "/admin/config": () => [403, { error: { message: "forbidden" } }] });
    return [[w.reqs.some(r => r.path === "/admin/config"), "拉过 /admin/config"],
            [hidden(w, "cfgSec"), "配置块藏着"],
            [!hidden(w, "main"), "页面其余部分照常可见"],
            [w.win.CONFIG == null, "内存里没有配置"]];
  }],
  ["h) 试打没 OK:生效是灰的,硬点也发不出去;表单一动就重新变灰", async () => {
    let probe = [200, { ok: false, latency_ms: 812, error: "upstream 401: invalid model" }];
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => probe,
                               "/admin/config/model": () => [200, { ok: true }] });
    const r = [];
    await w.call("cfgTierEdit", "smart");
    w.$("cfgTierProv").value = "openrouter"; w.$("cfgTierModel").value = "deepseek/deepseek-v4-pro";
    r.push([w.$("cfgTierApply").disabled === true, "打开表单时「生效」是灰的"]);
    await w.call("cfgTierApply");
    r.push([w.posts("/admin/config/model").length === 0, "没试打就点生效 → 没发 POST model"]);
    await w.call("cfgTierProbe");
    const pb = w.posts("/admin/config/probe")[0];
    r.push([pb && JSON.parse(pb.body).kind === "llm" && JSON.parse(pb.body).provider_id === "openrouter", "试打请求带 kind=llm + 候选供应商"]);
    r.push([w.$("cfgTierApply").disabled === true, "试打回 ok:false → 仍是灰的"]);
    r.push([w.$("cfgTierMsg").innerHTML.includes("invalid model"), "错误原文照实显示"]);
    await w.call("cfgTierApply");
    r.push([w.posts("/admin/config/model").length === 0, "试打失败后硬点生效 → 仍没发"]);
    probe = [200, { ok: true, latency_ms: 412 }];
    await w.call("cfgTierProbe");
    r.push([w.$("cfgTierApply").disabled === false, "试打 OK → 生效亮了"]);
    r.push([w.$("cfgTierMsg").innerHTML.includes("412"), "显示 latency"]);
    w.$("cfgTierModel").value = "deepseek/deepseek-v4-flash-0731";           // 改了但没触发 oninput(程序改值)
    await w.call("cfgTierApply");
    r.push([w.posts("/admin/config/model").length === 0, "试打后改了模型 → 生效函数自己核签名,不发"]);
    await w.call("cfgDirty", "cfgTier");
    r.push([w.$("cfgTierApply").disabled === true, "表单一动 → 重新变灰"]);
    await w.call("cfgTierProbe");
    await w.call("cfgTierApply");
    const mp = w.posts("/admin/config/model");
    r.push([mp.length === 1 && mp[0].body === JSON.stringify({ tier: "smart", provider_id: "openrouter", model_id: "deepseek/deepseek-v4-flash-0731" }),
            "重新试打 OK 后生效 → 恰好一发 POST model,带的是试打过的那一份"]);
    return r;
  }],
  ["i) 换 key:提交后框空了,DOM / 全局变量 / localStorage / URL / console / 其它请求里都找不到它", async () => {
    const K = fakeKey();
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: true, latency_ms: 240 }],
                               "/admin/config/key": () => [200, { ok: true, name: "SONIOX_API_KEY", last4: "n3Vb", len: 40, sha8: "2a3b4c5d" }] });
    const r = [];
    w.$("cfgKeyName").value = "SONIOX_API_KEY"; w.$("cfgKeyVal").value = K;
    await w.call("cfgKeyApply");
    r.push([w.posts("/admin/config/key").length === 0, "没试打就生效 → 没发 POST key"]);
    await w.call("cfgKeyProbe");
    const pb = w.posts("/admin/config/probe").map(x => JSON.parse(x.body));
    r.push([pb.length === 1 && pb[0].kind === "asr" && pb[0].key_name === "SONIOX_API_KEY" && pb[0].value === K, "试打的是框里这把新 key(kind=asr)"]);
    r.push([w.$("cfgKeyApply").disabled === false, "试打 OK → 生效亮了"]);
    await w.call("cfgKeyApply");
    const kp = w.posts("/admin/config/key");
    r.push([kp.length === 1 && JSON.parse(kp[0].body).value === K && JSON.parse(kp[0].body).name === "SONIOX_API_KEY", "恰好一发 POST key"]);
    r.push([w.$("cfgKeyVal").value === "", "输入框已清空"]);
    r.push([!domHas(w, K), "DOM 里任何元素的 value / innerHTML / textContent 都没有它"]);
    r.push([!deepHas(w.win, K), "页面全局变量(深搜)里没有它"]);
    r.push([![...w.store.values()].some(v => String(v).includes(K)), "localStorage 里没有它"]);
    r.push([!w.reqs.some(q => q.url.includes(K)), "任何请求 URL 里都没有它"]);
    r.push([!w.reqs.some(q => q.body && q.body.includes(K) && !["/admin/config/probe", "/admin/config/key"].includes(q.path)), "只出现在 probe / key 两发请求体里"]);
    r.push([!w.out.some(l => l.includes(K)), "console / alert 里没有它"]);
    r.push([w.$("cfgKeyMsg").innerHTML.includes("吊销"), "生效后提醒去上游吊销旧 key"]);
    await w.call("cfgKeyApply");
    r.push([w.posts("/admin/config/key").length === 1, "再点一次生效 → 不再发(要重新试打)"]);
    return r;
  }],
  ["j) 回包里混进疑似 key(≥32 位连续字母数字)—— 不渲染、报警", async () => {
    const L = fakeKey();
    const fx = cfgFixture(); fx.providers[1].display_name = "OpenRouter " + L;
    const w = await cfgWorld({ "/admin/config": () => [200, fx] });
    const r = [[hidden(w, "cfgBody"), "配置主体没画"],
                [!hidden(w, "cfgAlarm") && !hidden(w, "cfgSec"), "报警卡出来了"],
                [w.$("cfgAlarmBody").innerHTML.includes("密钥"), "报警说的是「疑似密钥」"],
                [!domHas(w, L), "那一段一个字都没进 DOM(报警里也没有)"],
                [w.win.CONFIG == null, "也没留在内存里的 CONFIG 上"]];
    // 回包干净、但试打的错误原文里夹着一段 —— 错误照报,那一段不显示
    const L2 = fakeKey();
    const w2 = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: false, error: "bad key " + L2 }] });
    await w2.call("cfgTierEdit", "fast");
    w2.$("cfgTierProv").value = "deepseek"; w2.$("cfgTierModel").value = "deepseek-v4-flash";
    await w2.call("cfgTierProbe");
    r.push([!domHas(w2, L2), "试打错误原文里的疑似 key 没进 DOM"]);
    r.push([w2.$("cfgTierApply").disabled === true, "那次试打不算 OK"]);
    return r;
  }],
  ["k) 回退:配置行有按钮、密钥行没有;回退发的是那一行的 audit_id", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/rollback": () => [200, { ok: true }] });
    const html = w.$("cfgAudit").innerHTML;
    const r = [[html.includes("cfgRollback('11')"), "config.model 行有「回退到这一版」"],
               [!html.includes("cfgRollback('12')"), "config.key 行没有回退按钮"],
               [!html.includes("cfgRollback('13')"), "config.probe 行(没有 before)没有回退按钮"],
               [w.$("cfgTiers").innerHTML.includes("config.model"), "「高级」档那一行显示了最后一条改动"]];
    await w.call("cfgRollback", "12");
    r.push([w.posts("/admin/config/rollback").length === 0, "硬调密钥行的回退 → 不发"]);
    w.st.confirm = false;
    await w.call("cfgRollback", "11");
    r.push([w.posts("/admin/config/rollback").length === 0, "确认框点了取消 → 不发"]);
    w.st.confirm = true;
    await w.call("cfgRollback", "11");
    const rb = w.posts("/admin/config/rollback");
    r.push([rb.length === 1 && JSON.parse(rb[0].body).audit_id === 11, "确认后恰好一发 rollback {audit_id:11}(数字,照服务端的 id)"]);
    return r;
  }],
  ["m) 供应商:服务端试打只打已存的那一行 —— 新加的 / 改了端点的不给 OK;没改的照常试打", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: true, latency_ms: 300 }],
                               "/admin/config/provider": () => [200, { ok: true }] });
    const r = [[!w.$("cfgProviders").innerHTML.includes("cfgProvEdit('soniox')") && w.$("cfgProviders").innerHTML.includes("cfgProvEdit('deepseek')"),
                "识别底座(asr 行)没有「编辑」(服务端 400 asr_locked),llm 行有"]];
    const fill = (id, endpoint) => {
      w.$("cfgProvId").value = id; w.$("cfgProvKind").value = "llm"; w.$("cfgProvName").value = "X";
      w.$("cfgProvEndpoint").value = endpoint; w.$("cfgProvDialect").value = "openai"; w.$("cfgProvKey").value = "OPENROUTER_API_KEY";
      w.$("cfgProvStrip").value = "thinking, reasoning_effort"; w.$("cfgProvParams").value = "{}"; w.$("cfgProvModel").value = "x/y";
      w.$("cfgProvEnabled").value = "1";
    };
    await w.call("cfgProvEdit", "");
    fill("newco", "https://api.example.com/v1/chat/completions");
    await w.call("cfgProvProbe");
    r.push([w.posts("/admin/config/probe").length === 0 && w.$("cfgProvApply").disabled === true, "新加的一家 → 不发试打、生效灰"]);
    await w.call("cfgProvApply");
    r.push([w.posts("/admin/config/provider").length === 0, "硬点生效 → 不发"]);
    await w.call("cfgProvEdit", "openrouter");
    fill("openrouter", "https://api.example.com/v1/chat/completions");
    await w.call("cfgProvProbe");
    r.push([w.posts("/admin/config/probe").length === 0 && w.$("cfgProvApply").disabled === true, "改了端点 → 不发试打、生效灰"]);
    fill("openrouter", "https://openrouter.ai/api/v1/chat/completions");
    await w.call("cfgProvProbe");
    r.push([w.posts("/admin/config/probe").length === 1 && w.$("cfgProvApply").disabled === false, "只改显示名 → 试打照常、OK 后亮"]);
    await w.call("cfgProvApply");
    r.push([w.posts("/admin/config/provider").length === 1, "生效 → 一发 POST provider"]);
    return r;
  }],
  ["l) 单价:先确认「影响下一把 lease 的预扣」,取消就不发", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/pricing": () => [200, { ok: true }] });
    const r = [[w.$("cfgPricing").innerHTML.includes("asr_rt_micros_per_second"), "单价表列出了各项"]];
    w.$("cfgPrice_0").value = "60";
    w.st.confirm = false;
    await w.call("cfgPriceApply", 0);
    r.push([w.confirms.length === 1 && w.confirms[0].includes("预扣"), "弹了确认,写明影响预扣"]);
    r.push([w.posts("/admin/config/pricing").length === 0, "取消 → 不发"]);
    w.st.confirm = true;
    await w.call("cfgPriceApply", 0);
    const pp = w.posts("/admin/config/pricing");
    r.push([pp.length === 1 && pp[0].body === JSON.stringify({ key: "asr_rt_micros_per_second", value: 60 }), "确认 → 一发 POST pricing {key, value:60}"]);
    return r;
  }],
];

let cfgBad = 0;
for (const [name, fn] of CFG_CASES) {
  console.log("\n══ " + name);
  let checks;
  try { checks = await fn(); } catch (e) { checks = [[false, "用例抛错:" + e.message]]; }
  for (const [pass, label] of checks) {
    console.log("   " + (pass ? "PASS" : "FAIL") + "  " + label);
    if (!pass) cfgBad++;
  }
}
bad += cfgBad;
console.log("\n" + (bad ? "✗ " + bad + " 条断言没过" : "✓ " + (CASES.length + CFG_CASES.length) + " 种情形全过"));
process.exit(bad ? 1 : 0);
