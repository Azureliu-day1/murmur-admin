// 管理后台会话续期的定向哨兵。
// 把 index.html 里那段 <script> 抽出来,喂给一个极小的假 DOM + 假 fetch,
// 记录调用顺序 —— 要证明的东西全在「谁先被打、带的是哪张 token」里。
import fs from "node:fs";
import vm from "node:vm";

const HTML = fs.readFileSync(process.argv[2] || "/Users/azure/Applications/murmur-admin-refresh/index.html", "utf8");
const m = HTML.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error("没找到 <script> 块"); process.exit(1); }
const CODE = m[1];
fs.writeFileSync("/private/tmp/claude-501/-Users-azure-Applications/e217a123-0e07-4610-b5e6-ea1d3251113c/scratchpad/extracted.js", CODE);

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
        dialect: "openai_compatible", key_name: "DEEPSEEK_API_KEY", default_params: {}, strip_params: [], enabled: true, updated_at: T0,
        host_allowlist: ["api.deepseek.com"] },
      { id: "openrouter", kind: "llm", display_name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions",
        dialect: "openai_compatible", key_name: "OPENROUTER_API_KEY", default_params: {}, strip_params: ["thinking", "reasoning_effort"], enabled: true, updated_at: T0,
        host_allowlist: ["openrouter.ai"] },
      { id: "soniox", kind: "asr", display_name: "Soniox", endpoint: "https://api.soniox.com/v1/auth/temporary-api-key",
        dialect: null, key_name: "SONIOX_API_KEY", default_params: {}, strip_params: [], enabled: true, updated_at: T0 },
    ],
    models: { fast: { provider_id: "deepseek", model_id: "deepseek-v4-flash", updated_at: T0 },
              smart: { provider_id: "deepseek", model_id: "deepseek-v4-flash", updated_at: T0 } },
    pricing: { asr_rt_micros_per_second: { micros_per_unit: 55, note: "实测", updated_at: T0 },
               llm_flash_in_per_mtok: 220000, llm_flash_out_per_mtok: 660000 },
    keys: [{ name: "DEEPSEEK_API_KEY", last4: "k9Qz", len: 35, sha8: "0a1b2c3d", updated_at: T0 },
           { name: "OPENROUTER_API_KEY", last4: "m2Wx", len: 73, sha8: "4e5f6a7b", updated_at: T0 },
           { name: "RESEND_API_KEY", last4: "h5Jk", len: 36, sha8: "6b7c8d9e", updated_at: null, source: "env", used_by: ["mail"] },
           { name: "SONIOX_API_KEY", last4: "p7Rt", len: 64, sha8: "8c9d0e1f", updated_at: T0 }],
    versions: { config_version: 7 },
    audit: [
      // 形状照服务端 GET /admin/config 的 audit:数字 id、actor_email、created_at,没有 target 列(对象在快照里)
      { id: 10, created_at: T0, actor_email: "admin@example.com", action: "config.pricing", reason: null, config_version: 6,
        before: { kind: "pricing", key: "asr_rt_micros_per_second", micros_per_unit: 50 }, after: { kind: "pricing", key: "asr_rt_micros_per_second", micros_per_unit: 55 } },
      { id: 11, created_at: T0, actor_email: "admin@example.com", action: "config.model", reason: null, config_version: 7,
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

// 远程配置夹具:形状照服务端真实现(murmur-all-remote 41c22dfb remoteAdminView):
// current = 下发外壳;builtin.styles[场景] = {text: 生产原文, knobs: 编辑器起始值};builtin 里 null = 客户端内置、服务端没登记
function rcFixture() {
  const env = { schema_version: 1, revision: 4, published_at: T0, refresh_s: 300,
    max_age_s: { flags: 86400, defaults: 86400, styles: 604800, copy: 604800 },
    flags: { kill_ai_card: false },
    defaults: { hud_done_seconds: 2.5 },
    styles: { chat: { register: "casual", punctuation: "light", keep_technical: true, structure: "prose" } },
    copy: { update_available: { zh: "有新版了,去看看", en: "New version out" } } };
  return cfgFixture({ remote: {
    schema_version: 1, revision: 4, published_at: T0, published_by: "admin@example.com", note: "聊天改随意", mail_status: "sent",
    current: env,
    clients: "schema_version 1:Mac 0.53 及以上的客户端会吃到这份配置;0.53 之前的版本拿不到、也不受影响;iOS 不接。",
    builtin: {
      source: "ime-mac 88b318ff",
      flags: { scene_styling_default_on: true, nextword_default_on: true, ai_card_default_on: null, kill_scene_styling: false, kill_ai_card: false },
      defaults: { hud_done_seconds: 1.8, parked_ttl_seconds: null, quota_warn_ratio: null },
      styles: { email: { text: "The text goes into an email. Prefer complete, courteous sentences.",
                         knobs: { register: "formal", punctuation: "complete", keep_technical: false, structure: "prose" } },
                chat: { text: "The text will be sent as a chat message.",
                        knobs: { register: "casual", punctuation: "light", keep_technical: false, structure: "prose" } },
                shortField: { text: null, knobs: { register: "neutral", punctuation: "light", keep_technical: false, structure: "prose" } } },
      copy: { quota_exhausted_free: null, quota_exhausted_pro: null,
              update_available: { zh: "新版本 {version} · 下载", en: "New version {version} · Download" } } },
    history: [{ revision: 4, published_at: T0, published_by: "admin@example.com", note: "聊天改随意", rollback_of: null, mail_status: "sent" },
              { revision: 3, published_at: T0, published_by: "admin@example.com", note: "HUD 2.5 秒", rollback_of: null, mail_status: "failed" },
              { revision: 2, published_at: T0, published_by: "admin@example.com", note: null, rollback_of: null, mail_status: "sent" }],
    limits: { preview_per_min: 6, extra_max_chars: 200 } } });
}

async function cfgWorld(routes, opt = {}) {
  const els = new Map();
  const $ = id => { if (!els.has(id)) { const e = makeEl(id); e.disabled = undefined; e.checked = false; els.set(id, e); } return els.get(id); };
  const store = new Map([["murmur.admin.session", JSON.stringify(LIVE)]]);
  const reqs = [], out = [], confirms = [];
  const st = { confirm: opt.confirm !== false, nonces: 0, issued: [] };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  function fetchStub(url, init = {}) {
    const path = url.replace(API_PREFIX, "").split("?")[0];
    const hdr = init.headers || {};
    reqs.push({ url, path, method: init.method || "GET", body: init.body == null ? null : String(init.body), confirm: hdr["x-admin-confirm"] || null });
    // 契约修正 1 §6:写之前先 POST /admin/config/challenge 拿一次性 nonce
    if (path === "/admin/config/challenge" && !routes[path]) {
      const n = "nonce-" + (++st.nonces); st.issued.push(n);
      return Promise.resolve(res(200, { nonce: n, expires_in: 300 }));
    }
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
           posts: p => reqs.filter(r => r.path === p && r.method === "POST"),
           // 每一发写都带着一个刚发出来、没用过的 nonce;试打不带
           noncesOk: () => {
             const writes = reqs.filter(r => r.method === "POST" && /^\/admin\/config\/(model|provider|pricing|key|rollback|remote|remote\/rollback)$/.test(r.path));
             const used = writes.map(r => r.confirm);
             return writes.length > 0 && used.every(n => n && st.issued.includes(n)) && new Set(used).size === used.length &&
                    reqs.filter(r => r.path === "/admin/config/probe" || r.path === "/admin/config/remote/preview").every(r => !r.confirm);
           } };
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
            "重新试打 OK 后生效 → 恰好一发 POST model,带的是试打过的那一份(价键没选 → 不带)"]);
    r.push([w.noncesOk(), "写请求带 x-admin-confirm(先 challenge 拿的一次性 nonce),试打不带"]);
    r.push([w.$("cfgModelsMsg").innerHTML.includes("沿用当前价键"), "价键没选 → 成功消息写「沿用当前价键」"]);
    return r;
  }],
  ["i) 换 key:提交后框空了,DOM / 全局变量 / localStorage / URL / console / 其它请求里都找不到它", async () => {
    const K = fakeKey();
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: true, latency_ms: 240 }],
                               "/admin/config/key": () => [200, { ok: true, key: { name: "SONIOX_API_KEY", last4: "n3Vb", len: 40, sha8: "2a3b4c5d" },
                                         reminder: "新 key 生效后请在上游控制台吊销旧 key;切换那一刻在途的请求可能失败一两次。我们这边不留旧值。" }] });
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
    r.push([w.$("cfgKeyMsg").innerHTML.includes("吊销") && w.$("cfgKeyMsg").innerHTML.includes("我们这边不留旧值") && w.$("cfgKeyMsg").innerHTML.includes("n3Vb"),
            "生效后原样显示服务端的 reminder(吊销旧 key / 在途请求)与新末四位"]);
    r.push([w.noncesOk(), "换 key 那一发也带一次性 nonce"]);
    r.push([!w.reqs.some(q => q.path === "/admin/config/challenge" && q.body && q.body.includes(K)), "challenge 请求里没有 key"]);
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
               [!html.includes("cfgRollback('10')") && html.includes("之后又改过"), "不是最新那条(config_version 6 ≠ 当前 7)→ 没有回退按钮,写「之后又改过」"],
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
    r.push([w.noncesOk(), "回退也带一次性 nonce"]);
    // 契约修正 1 §3:回退 = 以那一版生成一次新变更;版本链对不上 → 409 stale
    const w2 = await cfgWorld({ "/admin/config": () => [200, cfgFixture()],
                                "/admin/config/rollback": () => [409, { error: { message: "stale", code: "stale" } }] });
    await w2.call("cfgRollback", "11");
    r.push([w2.$("cfgAuditMsg").innerHTML.includes("配置已被后来的改动更新,刷新后再试"), "409 stale → 「配置已被后来的改动更新,刷新后再试」"]);
    return r;
  }],
  ["m) 供应商:只改已有那一家;host 不在白名单不发;改了端点 / 参数 = 试打并生效(服务端先用候选试);只改显示名照常先试打", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: true, latency_ms: 300 }],
                               "/admin/config/provider": () => [200, { ok: true }] });
    const tbl = w.$("cfgProviders").innerHTML;
    const r = [[!tbl.includes("cfgProvEdit('soniox')") && tbl.includes("cfgProvEdit('deepseek')"), "识别底座(asr 行)没有「编辑」(服务端 asr_locked),llm 行有"]];
    await w.call("cfgProvEdit", "openrouter");
    const form = w.$("cfgProvForm").innerHTML;
    const dsel = (form.match(/<select id="cfgProvDialect"[\s\S]*?<\/select>/) || [""])[0];
    r.push([(dsel.match(/<option /g) || []).length === 1 && dsel.includes('value="openai_compatible"'), "方言下拉只有 openai_compatible"]);
    r.push([/id="cfgProvId"[^>]*readonly/.test(form) && /id="cfgProvKey"[^>]*readonly/.test(form) && /id="cfgProvDialect" disabled/.test(form),
            "id / key 名只读、方言不可选(只能迁移改)"]);
    const fill = (endpoint, name) => {
      w.$("cfgProvId").value = "openrouter"; w.$("cfgProvName").value = name || "OpenRouter";
      w.$("cfgProvEndpoint").value = endpoint; w.$("cfgProvKey").value = "OPENROUTER_API_KEY";
      w.$("cfgProvStrip").value = "thinking, reasoning_effort"; w.$("cfgProvParams").value = "{}"; w.$("cfgProvModel").value = "";
      w.$("cfgProvEnabled").value = "1";
    };
    fill("https://api.example.com/v1/chat/completions");
    await w.call("cfgProvProbe");
    await w.call("cfgProvApply");
    r.push([w.posts("/admin/config/probe").length === 0 && w.posts("/admin/config/provider").length === 0 &&
            w.$("cfgProvMsg").innerHTML.includes("不在允许清单"), "host 不在白名单 → 不发试打、不发写、当场提示"]);
    fill("https://openrouter.ai/api/v2/chat/completions");
    await w.call("cfgProvProbe");
    r.push([w.posts("/admin/config/probe").length === 0 && w.$("cfgProvApply").disabled === false && w.$("cfgProvMsg").innerHTML.includes("试打并生效"),
            "改了端点(host 在白名单)→ 不发 /probe(它只打已存那一行),按钮变成试打并生效"]);
    w.st.confirm = false;
    await w.call("cfgProvApply");
    r.push([w.posts("/admin/config/provider").length === 0, "确认框取消 → 不发"]);
    w.st.confirm = true;
    await w.call("cfgProvApply");
    const pp = w.posts("/admin/config/provider").map(x => JSON.parse(x.body));
    r.push([pp.length === 1 && pp[0].endpoint === "https://openrouter.ai/api/v2/chat/completions" && !("key_name" in pp[0]) && !("kind" in pp[0]) &&
            !("dialect" in pp[0]) && w.noncesOk(), "确认 → 一发 POST provider(带 nonce),只带服务端收的字段"]);
    await w.call("cfgProvEdit", "openrouter");
    fill("https://openrouter.ai/api/v1/chat/completions", "OpenRouter(备用)");
    await w.call("cfgProvApply");
    r.push([w.posts("/admin/config/provider").length === 1, "只改显示名、没试打 → 生效不发"]);
    await w.call("cfgProvProbe");
    const pb = w.posts("/admin/config/probe").map(x => JSON.parse(x.body));
    r.push([pb.length === 1 && pb[0].provider_id === "openrouter" && !("provider" in pb[0]), "只改显示名 → 照常 /probe 那一家"]);
    await w.call("cfgProvApply");
    r.push([w.posts("/admin/config/provider").length === 2, "试打 OK 后生效 → 发出"]);
    return r;
  }],
  ["n) Resend / Stripe webhook 本期不可改:显示但禁用;没配的 key 显示「未配置」不当错误", async () => {
    const K = fakeKey();
    const fx = cfgFixture(); fx.keys[1] = { name: "OPENROUTER_API_KEY", configured: false, source: null, len: null, last4: null, sha8: null, updated_at: null, used_by: ["openrouter"] };
    const w = await cfgWorld({ "/admin/config": () => [200, fx], "/admin/config/probe": () => [200, { ok: true, latency_ms: 200 }],
                               "/admin/config/key": () => [200, { ok: true, key: {} }] });
    const sel = w.$("cfgKeyName").innerHTML, tbl = w.$("cfgKeys").innerHTML;
    const r = [[/value="RESEND_API_KEY" disabled/.test(sel), "下拉里 RESEND 是 disabled"],
               [tbl.includes("RESEND_API_KEY") && tbl.includes("这两把暂时只能在控制台改"), "表里照常显示,旁边一句只能在控制台改"],
               [w.$("cfgKeyName").value !== "RESEND_API_KEY", "默认选中的不是被锁的那把"],
               [tbl.includes("未配置") && !/class="err"/.test(tbl), "OpenRouter 没配 → 「未配置」,不是错误样式"]];
    w.$("cfgKeyName").value = "RESEND_API_KEY"; w.$("cfgKeyVal").value = K;
    await w.call("cfgKeyProbe");
    await w.call("cfgKeyApply");
    r.push([w.posts("/admin/config/probe").length === 0 && w.posts("/admin/config/key").length === 0, "硬选 RESEND 试打 / 生效 → 一发都不发"]);
    return r;
  }],
  ["o) 生效时服务端先试后写没过(400 probe_failed)→ 显示归一化错误,不说成功", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: true, latency_ms: 300 }],
      "/admin/config/model": () => [400, { probe: { ok: false, latency_ms: 812, error: "HTTP 404 · model_not_found" },
                                           error: { message: "候选配置试打没通过 —— 没有保存", code: "probe_failed" } }] });
    await w.call("cfgTierEdit", "smart");
    w.$("cfgTierProv").value = "openrouter"; w.$("cfgTierModel").value = "x/y";
    await w.call("cfgTierProbe");
    await w.call("cfgTierApply");
    const m = w.$("cfgTierMsg").innerHTML;
    return [[w.posts("/admin/config/model").length === 1, "发了一次 POST model"],
            [m.includes("试打没过") && m.includes("model_not_found") && m.includes("probe_failed"), "消息里有归一化错误(上游 code + probe_failed)"],
            [!w.$("cfgModelsMsg").innerHTML.includes("生效了"), "没有说「生效了」"],
            [w.$("cfgTierApply").disabled === true, "生效回到灰的(要重新试打)"]];
  }],
  ["p) 换模型时选了价键 → 请求带 in_price_key / out_price_key;价键也进签名", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, cfgFixture()], "/admin/config/probe": () => [200, { ok: true, latency_ms: 300 }],
                               "/admin/config/model": () => [200, { ok: true }] });
    await w.call("cfgTierEdit", "smart");
    const form = w.$("cfgTierForm").innerHTML;
    w.$("cfgTierProv").value = "openrouter"; w.$("cfgTierModel").value = "x/y"; w.$("cfgTierIn").value = ""; w.$("cfgTierOut").value = "";
    await w.call("cfgTierProbe");
    w.$("cfgTierIn").value = "llm_flash_in_per_mtok"; w.$("cfgTierOut").value = "llm_flash_out_per_mtok";   // 试打后才改价键
    await w.call("cfgTierApply");
    const r = [[form.includes("沿用当前价键") && form.includes("llm_flash_in_per_mtok"), "表单里有价键下拉,默认「沿用当前价键」"],
               [w.posts("/admin/config/model").length === 0, "试打后改了价键 → 签名对不上,不发"]];
    await w.call("cfgTierProbe");
    await w.call("cfgTierApply");
    const mp = w.posts("/admin/config/model").map(x => JSON.parse(x.body));
    r.push([mp.length === 1 && mp[0].in_price_key === "llm_flash_in_per_mtok" && mp[0].out_price_key === "llm_flash_out_per_mtok", "重新试打后生效 → 带上两个价键"]);
    return r;
  }],
  ["q) 换 key:那家没挂在任何档 → 显示「试打模型」框;不填不发;填了试打与生效都带 model_id;挂了档的家不显示", async () => {
    const K = fakeKey();
    const fx = cfgFixture();
    fx.providers.push({ id: "openai", kind: "llm", display_name: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions",
      dialect: "openai_compatible", key_name: "OPENAI_API_KEY", default_params: {}, strip_params: [], enabled: true, updated_at: T0, host_allowlist: ["api.openai.com"] });
    fx.keys.push({ name: "OPENAI_API_KEY", configured: false, source: null, writable: true, len: null, last4: null, sha8: null, updated_at: null, used_by: ["openai"] });
    const w = await cfgWorld({ "/admin/config": () => [200, fx], "/admin/config/probe": () => [200, { ok: true, latency_ms: 300 }],
                               "/admin/config/key": () => [200, { ok: true, key: { last4: "q8Zt" }, reminder: "吊销旧 key" }] });
    const r = [];
    w.$("cfgKeyName").value = "DEEPSEEK_API_KEY"; await w.call("cfgKeyDirty");
    r.push([hidden(w, "cfgKeyModelBox"), "DEEPSEEK(挂在 fast 档)→ 不显示试打模型框"]);
    w.$("cfgKeyName").value = "OPENAI_API_KEY"; await w.call("cfgKeyDirty");
    r.push([!hidden(w, "cfgKeyModelBox"), "OPENAI(没挂档)→ 显示试打模型框"]);
    w.$("cfgKeyVal").value = K; w.$("cfgKeyModel").value = "";
    await w.call("cfgKeyProbe");
    r.push([w.posts("/admin/config/probe").length === 0 && w.$("cfgKeyMsg").innerHTML.includes("这家还没用在任何档,试打要指定一个模型 id"),
            "模型没填 → 不发试打,提示要指定模型 id"]);
    w.$("cfgKeyModel").value = "gpt-x-mini"; await w.call("cfgKeyDirty");
    await w.call("cfgKeyProbe");
    const pb = w.posts("/admin/config/probe").map(x => JSON.parse(x.body));
    r.push([pb.length === 1 && pb[0].model_id === "gpt-x-mini" && pb[0].key_name === "OPENAI_API_KEY", "填了 → 试打带 model_id"]);
    w.$("cfgKeyModel").value = "gpt-other";                     // 试打后改模型(不经 oninput)
    await w.call("cfgKeyApply");
    r.push([w.posts("/admin/config/key").length === 0, "试打后改了模型 → 生效不发"]);
    w.$("cfgKeyModel").value = "gpt-x-mini";
    await w.call("cfgKeyDirty"); w.$("cfgKeyVal").value = K;
    await w.call("cfgKeyProbe"); await w.call("cfgKeyApply");
    const kp = w.posts("/admin/config/key").map(x => JSON.parse(x.body));
    r.push([kp.length === 1 && kp[0].model_id === "gpt-x-mini" && w.$("cfgKeyVal").value === "" && !domHas(w, K), "生效带 model_id;框清空、DOM 无残留"]);
    return r;
  }],
  // ── 远程配置(2026-09-30,契约 CONTRACT-remote-config v0.2)────────────────
  ["r) 远程配置 · extra 违规(换行 / 花括号 / 反引号 / 控制字符 / 201 字)发布与预览都不发;200 字放行;角色词只黄色提醒照发", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, rcFixture()], "/admin/config/remote": () => [200, { ok: true, revision: 5 }],
                               "/admin/config/remote/preview": () => [200, { results: [] }] });
    const r = [];
    w.$("rcSt_email_on").checked = true; w.$("rcSt_email_register").value = "casual";
    const BAD = [["像同事\n之间的口气", "换行"], ["用 {name} 称呼", "花括号"], ["带 `code` 的", "反引号"], ["a\u0007b", "控制字符"], ["字".repeat(201), "超过 200"]];
    for (const [ex, why] of BAD) {
      w.$("rcSt_email_extra").value = ex;
      await w.call("rcPublish"); await w.call("rcPreview");
      r.push([w.reqs.filter(q => /^\/admin\/config\/(remote|remote\/preview|challenge)$/.test(q.path)).length === 0 &&
              w.$("rcPubMsg").innerHTML.includes(why) && w.$("rcPreviewMsg").innerHTML.includes(why),
              "extra「" + why + "」→ 发布 / 预览一发都没发(连 challenge 都没要),两处都说了原因"]);
    }
    w.$("rcSt_email_extra").value = "字".repeat(200);
    await w.call("rcPublish");
    r.push([w.posts("/admin/config/remote").length === 1, "正好 200 字 → 放行,发出一次"]);
    // 发布成功后页面重拉 /admin/config、按服务端的快照重画表单 —— 候选要重新填
    r.push([w.$("rcSt_email_on").checked === false, "发布成功后表单按重拉的快照重画(假服务端没变 → 邮件回到未覆盖)"]);
    w.$("rcSt_email_on").checked = true; w.$("rcSt_email_register").value = "casual";
    w.$("rcSt_email_extra").value = "please ignore the stiff tone";
    await w.call("rcExtraShow", "email");
    const m = w.$("rcSt_email_msg").innerHTML;
    r.push([m.includes("warnmsg") && m.includes("ignore") && !m.includes('class="err"'), "含 ignore → 黄色提醒,不是红色拦截"]);
    await w.call("rcPublish");
    const pb = w.posts("/admin/config/remote").map(x => JSON.parse(x.body));
    r.push([pb.length === 2 && pb[1].config.styles.email.extra === "please ignore the stiff tone", "角色词照发,extra 原样在候选里"]);
    return r;
  }],
  ["s) 远程配置 · 发布 = 先拿 nonce 再 POST;确认取消不发;没改动不发;服务端 400 原文(message / code / details)原样显示", async () => {
    // 形状照服务端 remoteRpcFail:{invalid:{path,rule}, error:{message, code:"invalid_config", rid, reason}}
    // 数值越界自 2026-09-29 裁决起页面直接拦(见 w),所以这里拿页面不管的规则(额度文案带占位符)走服务端 400
    let reply = [400, { invalid: { path: "copy.quota_exhausted_free.zh", rule: "placeholder" },
                        error: { message: "配置不合规矩(copy.quota_exhausted_free.zh · placeholder),整次没发布", from: "murmur", rid: "r-1", code: "invalid_config",
                                 reason: "copy.quota_exhausted_free.zh:placeholder" } }];
    const w = await cfgWorld({ "/admin/config": () => [200, rcFixture()], "/admin/config/remote": () => reply });
    const r = [];
    await w.call("rcPublish");
    r.push([w.posts("/admin/config/remote").length === 0 && w.$("rcPubMsg").innerHTML.includes("没什么可发布"), "什么都没改 → 不发,说没什么可发布"]);
    w.$("rcC_quota_exhausted_free_zh").value = "额度用完了 {version}"; w.$("rcC_quota_exhausted_free_en").value = "Quota used up {version}";
    w.st.confirm = false;
    await w.call("rcPublish");
    r.push([w.confirms.some(c => c.includes("copy.quota_exhausted_free") && c.includes("revision 5")), "确认框列出改了哪一项、发布后是 revision 5"]);
    r.push([w.reqs.filter(q => q.path === "/admin/config/challenge" || q.path === "/admin/config/remote").length === 0, "取消 → challenge 与发布都没发"]);
    w.st.confirm = true;
    await w.call("rcPublish");
    const rq = w.reqs.filter(q => q.path === "/admin/config/challenge" || q.path === "/admin/config/remote").map(q => q.path);
    const pb = w.posts("/admin/config/remote");
    const body = pb[0] && JSON.parse(pb[0].body);
    r.push([rq.join(",") === "/admin/config/challenge,/admin/config/remote", "顺序:先 challenge,再 POST remote"]);
    r.push([w.noncesOk(), "POST remote 带 x-admin-confirm = 刚发的一次性 nonce"]);
    r.push([body && body.expect_revision === 4 && body.config.copy.quota_exhausted_free.zh === "额度用完了 {version}" &&
            body.config.defaults.hud_done_seconds === 2.5 && body.config.styles.chat &&
            body.config.copy.update_available.zh === "有新版了,去看看" && !("revision" in body.config) && !("refresh_s" in body.config),
            "请求体 = {expect_revision:4, config: 完整候选快照(没改的键照带,不夹下发外壳字段)}"]);
    const em = w.$("rcPubMsg").innerHTML;
    r.push([em.includes("配置不合规矩(copy.quota_exhausted_free.zh · placeholder)") && em.includes("invalid_config") && em.includes("&quot;rule&quot;:&quot;placeholder&quot;") && em.includes("整次没发布"),
            "400 → 服务端原文 message + code + details 原样摆出来,并写明整次没发布"]);
    reply = [200, { ok: true, action: "config.remote.publish", revision: 5, previous: 4, warnings: [{ path: "styles.email.extra", word: "system" }], mail: "pending" }];
    const gets0 = w.reqs.filter(q => q.path === "/admin/config" && q.method === "GET").length;
    w.$("rcD_hud_done_seconds").value = "3";
    await w.call("rcPublish");
    r.push([w.$("rcPubMsg").innerHTML.includes("发布了 revision 5") && w.posts("/admin/config/remote").length === 2, "合法 → 发出,回 revision 5"]);
    r.push([w.reqs.filter(q => q.path === "/admin/config" && q.method === "GET").length > gets0, "发布成功后重拉 /admin/config"]);
    r.push([w.$("rcPubMsg").innerHTML.includes("warnmsg") && w.$("rcPubMsg").innerHTML.includes("styles.email.extra「system」"), "服务端回的角色词告警黄色显示"]);
    r.push([w.noncesOk(), "两次发布各用一个 nonce,没有复用"]);
    return r;
  }],
  ["t) 远程配置 · 回退只挂在最近一次;取消不发;409 stale 说人话;带 nonce;配置留痕里 config.remote 行不给旧回退按钮", async () => {
    const fx = rcFixture();
    fx.audit = cfgFixture().audit.concat([{ id: 20, created_at: T0, actor_email: "admin@example.com", action: "config.remote.publish", config_version: 7,
                                            before: { revision: 3 }, after: { revision: 4 } }]);
    let reply = [409, { error: { message: "stale", code: "stale" } }];
    const w = await cfgWorld({ "/admin/config": () => [200, fx], "/admin/config/remote/rollback": () => reply });
    const h = w.$("rcHistory").innerHTML;
    const rows = h.split("<tr>").filter(x => x.includes("r"));
    const r = [[(h.match(/rcRollback\(\)/g) || []).length === 1, "历史三行,只有一个回退按钮"],
               [rows.some(x => x.includes("r4") && x.includes("rcRollback()") && x.includes("回到 r3")), "按钮在 r4(当前)那一行,写明回到 r3"],
               [!w.$("cfgAudit").innerHTML.includes("cfgRollback('20')") && w.$("cfgAudit").innerHTML.includes("在「远程配置」里回退"),
                "配置留痕里 config.remote.publish 行没有旧的「回退到这一版」"]];
    w.st.confirm = false;
    await w.call("rcRollback");
    r.push([w.posts("/admin/config/remote/rollback").length === 0, "确认取消 → 不发"]);
    w.st.confirm = true;
    await w.call("rcRollback");
    const rb = w.posts("/admin/config/remote/rollback").map(x => JSON.parse(x.body));
    r.push([rb.length === 1 && rb[0].expect_revision === 4 && rb[0].to_revision === 3, "发出 {expect_revision:4, to_revision:3}"]);
    r.push([w.noncesOk(), "回退也带一次性 nonce"]);
    r.push([w.$("rcHistMsg").innerHTML.includes("配置已被后来的改动更新,刷新后再试"), "409 stale → 「配置已被后来的改动更新,刷新后再试」"]);
    const fx1 = rcFixture(); fx1.remote.revision = 0; fx1.remote.history = [{ revision: 0, published_at: T0, published_by: null }];
    const w1 = await cfgWorld({ "/admin/config": () => [200, fx1] });
    r.push([!w1.$("rcHistory").innerHTML.includes("rcRollback()") && w1.$("rcHistory").innerHTML.includes("没有更早的版本") &&
            w1.$("rcHistory").innerHTML.includes("从未发布"), "只有 r0(从未发布)→ 没有回退按钮"]);
    // r1 是第一次发布:可以回退到 r0(= 全用内置,服务端认 to_revision 0)
    const fx2 = rcFixture(); fx2.remote.revision = 1; fx2.remote.history = [{ revision: 1, published_at: T0, published_by: "admin@example.com" }];
    const w2 = await cfgWorld({ "/admin/config": () => [200, fx2], "/admin/config/remote/rollback": () => [200, { ok: true, revision: 2 }] });
    await w2.call("rcRollback");
    const rb2 = w2.posts("/admin/config/remote/rollback").map(x => JSON.parse(x.body));
    r.push([w2.$("rcHistory").innerHTML.includes("回到 r0") && rb2.length === 1 && rb2[0].to_revision === 0 && rb2[0].expect_revision === 1,
            "当前 r1 → 可以回退到 r0(to_revision 0 = 从未发布)"]);
    return r;
  }],
  ["u) 远程配置 · 预览:发的是候选 styles、不带 nonce;结果标「只供人眼看,不是质量证明」;结果不落 localStorage / 全局变量;改了候选提示结果旧了", async () => {
    const MARK = "PREVIEW_OUT_" + Date.now();
    // 形状照服务端 handleRemotePreview:samples[];任一条失败整体 ok:false,但 HTTP 200、其余照有结果
    let reply = [200, { ok: false, note: "只供人眼看,不是质量证明", samples: ["email", "chat", "document", "code", "aiAssistant"].map((sc, i) =>
                 (i === 4 ? { id: "s5", scene: sc, input: "样例 " + i, style_source: "builtin", ok: false, error: "timeout", latency_ms: 10000 }
                          : { id: "s" + (i + 1), scene: sc, input: "样例 " + i, style_source: i === 0 ? "candidate" : "builtin", ok: true, output: MARK + "_" + i, latency_ms: 400 + i })),
                 cost_micro_usd: 90, spent_today_micro_usd: 300, budget_micro_usd: 1000000, warnings: [] }];
    const w = await cfgWorld({ "/admin/config": () => [200, rcFixture()], "/admin/config/remote/preview": () => reply });
    const r = [];
    w.$("rcSt_email_on").checked = true; w.$("rcSt_email_register").value = "casual"; w.$("rcSt_email_extra").value = "像同事之间的口气";
    await w.call("rcPreview");
    const pv = w.posts("/admin/config/remote/preview");
    const b = pv[0] && JSON.parse(pv[0].body);
    r.push([pv.length === 1 && b.styles.email.register === "casual" && b.styles.email.extra === "像同事之间的口气" && b.styles.chat.register === "casual",
            "发的是候选 styles(邮件的新旋钮 + extra,chat 照旧)"]);
    r.push([!pv[0].confirm && !w.reqs.some(q => q.path === "/admin/config/challenge"), "预览不带 nonce、不要 challenge(它不写配置)"]);
    r.push([w.$("rcPreview").innerHTML.includes("只供人眼看,不是质量证明"), "结果那一格标了「只供人眼看,不是质量证明」"]);
    r.push([[0, 1, 2, 3].every(i => w.$("rcPreview").innerHTML.includes(MARK + "_" + i)) && w.$("rcPreview").innerHTML.includes("出错:timeout"),
            "整体 ok:false 也照画:4 条结果 + 失败那条标「出错:timeout」"]);
    r.push([![...w.store.values()].some(v => String(v).includes(MARK)), "localStorage 里没有预览结果"]);
    r.push([!deepHas(w.win, MARK), "页面全局变量(深搜)里没有预览结果"]);
    r.push([w.posts("/admin/config/remote").length === 0, "预览没顺手发布"]);
    w.$("rcSt_email_register").value = "formal";
    await w.call("rcStylesDirty");
    r.push([w.$("rcPreviewMsg").innerHTML.includes("结果是旧候选的") && w.$("rcPreview").innerHTML.includes("只供人眼看,不是质量证明"),
            "预览后改了候选 → 提示结果是旧的,免责标签还在"]);
    reply = [429, { error: { message: "preview rate limited (6/min)", code: "preview_rate_limited" } }];
    await w.call("rcPreview");
    r.push([w.$("rcPreviewMsg").innerHTML.includes("preview_rate_limited") && w.$("rcPreviewMsg").innerHTML.includes("6/min"), "429 → 服务端原文照摆"]);
    return r;
  }],
  ["v) 远程配置 · 三卡:内置默认 vs 当前远程、revision、最后改动、schema 说明;服务端没有 remote → 一句说明,其余配置照常", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, rcFixture()] });
    const f = w.$("rcFlags").innerHTML, st = w.$("rcStyles").innerHTML, cp = w.$("rcCopy").innerHTML;
    const r = [[f.includes("1.8") && f.includes("<b>2.5</b>") && f.includes("r4"), "HUD 停留:内置 1.8 vs 远程 2.5,最后改动 r4"],
               [(f.match(/chip pub/g) || []).length === 3, "三个公开键标了「公开」"],
               [f.includes("未设 = 用内置"), "没下发的键写「未设 = 用内置」"],
               [st.includes("当前远程:随意") && st.includes("Prefer complete, courteous sentences") && st.includes("没有场景风格段"),
                "场景风格:chat 远程随意;内置那格是生产原文(email),shortField 写没有风格段"],
               [w.$("rcSt_email_register").value === "formal" && w.$("rcSt_email_keep_technical").value === "0", "没覆盖的场景,旋钮起始值 = 服务端给的 knobs"],
               [f.includes("客户端内置"), "服务端没登记的内置值(null)写「客户端内置」"],
               [w.$("rcHistory").innerHTML.includes("告警信没发出"), "r3 告警信 failed → 历史里标出来"],
               [w.$("rcSt_chat_on").checked === true && w.$("rcSt_email_on").checked === false, "有远程覆盖的场景勾上,没有的不勾"],
               [cp.includes("新版本 {version} · 下载") && cp.includes("有新版了,去看看"), "文案:内置 vs 远程都显示"],
               [w.$("rcSchema").innerHTML.includes("0.53"), "schema_version 说明写了 0.53 及以上会吃到"],
               [w.$("rcVer").textContent.includes("revision 4"), "页眉 revision 4"],
               [w.$("rcD_hud_done_seconds").value === "2.5" && w.$("rcF_kill_ai_card").value === "0" && w.$("rcF_nextword_default_on").value === "",
                "新值框预填当前远程值(没下发的 = 空 = 不设)"]];
    const w2 = await cfgWorld({ "/admin/config": () => [200, cfgFixture()] });
    r.push([!hidden(w2, "rcNone") && hidden(w2, "rcBody") && w2.$("rcNone").innerHTML.includes("还没有远程配置"), "没有 remote → 一句说明,三卡不画"]);
    r.push([w2.$("cfgTiers").innerHTML.includes("deepseek-v4-flash"), "模型与供应商那一块照常"]);
    const fx3 = cfgFixture({ remote: { error: "remote_read_failed" } });
    const w3 = await cfgWorld({ "/admin/config": () => [200, fx3] });
    await w3.call("rcPublish");
    r.push([hidden(w3, "rcBody") && w3.$("rcNone").innerHTML.includes("remote_read_failed") && w3.posts("/admin/config/remote").length === 0,
            "服务端读挂了(remote.error)→ 显示原因、三卡不画、发布不发"]);
    return r;
  }],
  ["w) 远程配置 · 数值越界页面直接拦:红字写范围、发布按钮禁用、硬点也不发;范围优先读服务端元数据,没有就用契约表", async () => {
    const w = await cfgWorld({ "/admin/config": () => [200, rcFixture()], "/admin/config/remote": () => [200, { ok: true, revision: 5 }] });
    const r = [[w.$("rcPubBtn").disabled === false, "当前值都在范围内 → 发布按钮可点"],
               [w.$("rcFlags").innerHTML.includes("0.8–4") && w.$("rcFlags").innerHTML.includes("10–180") && w.$("rcFlags").innerHTML.includes("0.5–0.95"),
                "没有服务端元数据 → 按契约表写范围(0.8–4 / 10–180 / 0.5–0.95)"]];
    const sent = () => w.reqs.filter(q => q.path === "/admin/config/challenge" || q.path === "/admin/config/remote").length;
    for (const [k, v, rg] of [["hud_done_seconds", "9", "0.8–4"], ["hud_done_seconds", "0.79", "0.8–4"], ["parked_ttl_seconds", "181", "10–180"], ["quota_warn_ratio", "0.96", "0.5–0.95"]]) {
      w.$("rcD_" + k).value = v;
      await w.call("rcNumCheck", k);
      const m = w.$("rcD_" + k + "_msg").innerHTML;
      r.push([m.includes('class="err"') && m.includes(rg) && w.$("rcPubBtn").disabled === true, k + " = " + v + " → 红字写「" + rg + "」、发布按钮禁用"]);
      await w.call("rcPublish");
      r.push([sent() === 0 && w.$("rcPubMsg").innerHTML.includes("defaults." + k), "硬调发布 → challenge 与发布都没发,说了哪一项"]);
      w.$("rcD_" + k).value = ""; await w.call("rcNumCheck", k);
    }
    w.$("rcD_hud_done_seconds").value = "4.0";
    await w.call("rcNumCheck", "hud_done_seconds");
    r.push([w.$("rcPubBtn").disabled === false && w.$("rcD_hud_done_seconds_msg").innerHTML === "", "边界 4.0 → 放行、按钮可点、没红字"]);
    await w.call("rcPublish");
    r.push([w.posts("/admin/config/remote").length === 1 && JSON.parse(w.posts("/admin/config/remote")[0].body).config.defaults.hud_done_seconds === 4,
            "边界值照发(发的是数字 4)"]);
    // 服务端元数据给了范围 → 用它({min,max} 与 [min,max] 两种形状)
    const fx = rcFixture();
    fx.remote.limits.defaults = { hud_done_seconds: { min: 1, max: 3 } };
    fx.remote.ranges = { defaults: { parked_ttl_seconds: [20, 90] } };
    const w2 = await cfgWorld({ "/admin/config": () => [200, fx] });
    r.push([w2.$("rcFlags").innerHTML.includes("1–3") && w2.$("rcFlags").innerHTML.includes("20–90"), "有服务端元数据 → 范围列写服务端给的(1–3 / 20–90)"]);
    w2.$("rcD_hud_done_seconds").value = "3.5"; await w2.call("rcNumCheck", "hud_done_seconds");
    r.push([w2.$("rcD_hud_done_seconds_msg").innerHTML.includes("1–3") && w2.$("rcPubBtn").disabled === true, "3.5 在契约表内但超出服务端的 1–3 → 拦"]);
    w2.$("rcD_hud_done_seconds").value = ""; await w2.call("rcNumCheck", "hud_done_seconds");
    w2.$("rcD_parked_ttl_seconds").value = "100"; await w2.call("rcNumCheck", "parked_ttl_seconds");
    r.push([w2.$("rcPubBtn").disabled === true && w2.$("rcD_parked_ttl_seconds_msg").innerHTML.includes("20–90"), "数组形状 [20, 90] 也认:100 → 拦"]);
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
    r.push([w.noncesOk(), "单价那一发也带一次性 nonce"]);
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
