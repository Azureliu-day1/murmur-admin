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

const EXPECT = {
  "a": r => [[r.refreshes === 0, "refresh 次数 = 0"],
             [r.log.filter(l => l.includes("← 200")).length === 2, "stats + access 各一次 200"],
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
             [r.log.filter(l => l.includes("← 401")).length === 2, "两条各挨一个 401"],
             [r.log.filter(l => l.includes("Bearer ACCESS_v1") && l.includes("← 200")).length === 2, "两条都用新 token 重试成功"],
             [!r.mainHidden, "主体可见"]],
  "f": r => [[r.refreshes === 1, "refresh 恰好 1 次"],
             [r.log.filter(l => l.includes("← 401")).length === 2, "先各挨一个 401(没有提前续期,因为不知道到期时刻)"],
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
console.log("\n" + (bad ? "✗ " + bad + " 条断言没过" : "✓ " + CASES.length + " 种情形全过"));
process.exit(bad ? 1 : 0);
