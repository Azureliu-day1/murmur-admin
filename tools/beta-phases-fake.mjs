// 开放阶段(内测 → 公测)的本地假服务 —— 服务端动作还没上线,先按契约把后台页的读改流程跑通。
//
// 契约来源:murmur-all docs/DESIGN-beta-phases.md v0.2「接口契约」(动作名)+ 服务端施工路线 S4(cohort_quotas_set、
// 字段名)。回包形状契约没写死,这里和 admin.js 里 phNorm 上方那段注释是**同一份假定**,服务端定稿后两边一起对齐。
//
// 两种用法:
//   1) import { createFake } —— 哨兵(session-harness.mjs)和截图脚本直接调 route(),不起端口;
//   2) node tools/beta-phases-fake.mjs [端口] [closed|public]
//        → 在 127.0.0.1 上起一个页面 + 假 API:index.html / admin.js / admin.css 原样读进来,只在**内存里**把 admin.js 的 HOST
//          换成本机、由同源 /fake-session.js 塞一份假会话(假 token,不是 JWT),文件本身不动、CSP 不动。
//
// ⛔ 公开仓:夹具只用 example.com 邮箱和假计数;不写任何真邮箱、真 token、真项目 id 以外的东西。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ADMIN = "admin@example.com";
const T0 = "2026-10-01T03:00:00Z";

// 服务端范围校验(页面上的 PH_FIELDS 是先挡一道;这里是假服务的「真门」,数字同一份)
const LIMITS = {
  closed_cap: [0, 100000], public_cap: [0, 100000], total_cap: [0, 100000],
  site_budget_micro_usd: [0, 10000e6], staff_budget_micro_usd: [0, 10000e6],
  budget_alert_ratio: [0.05, 1], budget_stop_ratio: [0.05, 1],
  release_batch: [1, 500], release_daily_max: [1, 5000],
  weekly_chars: [0, 1000000], monthly_cost_cap_micro_usd: [0, 1000e6], ime_cloud_daily: [0, 100000], lecture_trial_seconds: [0, 36000],
};
const SETTING_KEYS = ["phase", "accepting", "auto_release", "closed_cap", "public_cap", "total_cap", "release_batch", "release_daily_max",
                      "site_budget_micro_usd", "staff_budget_micro_usd", "budget_alert_ratio", "budget_stop_ratio"];
const QUOTA_KEYS = ["weekly_chars", "monthly_cost_cap_micro_usd", "ime_cloud_daily", "lecture_trial_seconds"];

const freeQuota = () => ({ weekly_chars: 2000, monthly_cost_cap_micro_usd: 500000, ime_cloud_daily: 10, lecture_trial_seconds: 180 });
const uid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

// 两个场景:closed = 上线当天的样子(内测、自动放行关);public = 公测满额、有人在候补
export function seed(scene = "closed") {
  const pub = scene === "public";
  const s = {
    settings: { phase: pub ? "public" : "closed", accepting: true, auto_release: pub,
                closed_cap: 20, public_cap: 100, total_cap: pub ? 300 : 120,
                release_batch: 10, release_daily_max: 20,
                site_budget_micro_usd: 60e6, staff_budget_micro_usd: 5e6, budget_alert_ratio: 0.7, budget_stop_ratio: 0.85,
                updated_at: T0, updated_by: ADMIN },
    // FIX2 B2:pending = pending_review(等审核)+ pending_login(等首次登录,公测已标 eligible)—— 与服务端 murmur_access_get 同形
    counts: pub ? { closed: 18, public: 100, staff: 1, waitlisted: 20, pending: 0, pending_review: 0, pending_login: 0, released_today: 0 }
                : { closed: 4, public: 0, staff: 1, waitlisted: 0, pending: 2, pending_review: 2, pending_login: 0, released_today: 0 },
    budget: { month: "2026-10",
              site: pub ? { reserved_micro_usd: 1.5e6, spent_micro_usd: 41e6 } : { reserved_micro_usd: 0.4e6, spent_micro_usd: 7.6e6 },
              staff: { reserved_micro_usd: 0, spent_micro_usd: 1.2e6 } },
    quotas: { closed: freeQuota(), public: freeQuota() },
    staff: [{ user_id: uid(1), email: "staff@example.com", added_at: T0, added_by: ADMIN }],
    audit: [],
    requests: [],
  };
  // 申请名额栏的假行:候补的人数和 counts.waitlisted 对上
  let n = 100;
  const req = (status, i, extra) => Object.assign({ id: uid(++n), email: "applicant" + i + "@example.com", note: "", lang: "zh",
    created_at: T0, has_seat: status === "approved", has_user: true, status, eligible_at: null }, extra || {});
  if (pub) {
    for (let i = 1; i <= s.counts.waitlisted; i++) s.requests.push(req("waitlisted", i, { queued_at: T0 }));
  } else {
    s.requests.push(req("new", 1, { note: "朋友介绍" }), req("new", 2));
  }
  s.requests.push(req("approved", 90, { handled_by: ADMIN, handled_at: T0 }));
  return s;
}

// 稳定序列化(键排序)—— 确认码绑「动作 + 参数」用
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

export function createFake(scene = "closed") {
  const st = seed(scene);
  const nonces = new Map();          // nonce → {action, params, used, exp}
  const log = [];                    // 每一发(方法、路径、动作、结果码)—— 哨兵 / 冒烟拿它核
  let auditId = 0;

  const view = () => ({
    ok: true,
    settings: { ...st.settings },
    counts: { ...st.counts },
    budget: JSON.parse(JSON.stringify(st.budget)),
    quotas: Object.keys(st.quotas).map((c) => ({ cohort: c, ...st.quotas[c] })),
    staff: st.staff.map((x) => ({ ...x })),
    audit: st.audit.slice(0, 10),
  });
  const fail = (status, code, message) => [status, { error: { message, code, from: "murmur" } }];
  const audit = (action, before, after, target) => {
    st.audit.unshift({ id: ++auditId, at: new Date().toISOString(), actor: ADMIN, action, target: target || null, before, after, reason: null });
  };
  const checkNum = (k, v) => {
    const r = LIMITS[k];
    if (typeof v !== "number" || !isFinite(v)) return k + " 要一个数字";
    if (r && (v < r[0] || v > r[1])) return k + " 要在 " + r[0] + "–" + r[1] + " 之间";
    if (/cap$|_batch$|_max$|chars$|daily$|seconds$|micro_usd$/.test(k) && Math.floor(v) !== v) return k + " 要整数";
    return null;
  };
  const room = (s) => Math.max(0, Math.min(s.phase === "public" ? s.public_cap - st.counts.public : s.closed_cap - st.counts.closed,
                                          s.total_cap - st.counts.closed - st.counts.public));

  function takeNonce(headers, action, params) {
    const n = headers["x-admin-confirm"] || "";
    const rec = nonces.get(n);
    if (!rec || rec.used || rec.exp < Date.now()) return "确认码无效、过期或已用过 —— 重新拿一个";
    if (rec.action !== action || rec.params !== stable(params)) return "确认码和这次的动作 / 参数对不上";
    rec.used = true;
    return null;
  }

  function action(b, headers) {
    const act = String(b.action || "");
    const params = { ...b }; delete params.action;
    if (act === "access_get") return [200, view()];
    const WRITES = ["access_set", "cohort_quotas_set", "waitlist_release", "staff_add", "staff_remove"];
    if (!WRITES.includes(act)) return [400, { error: { message: "不认识的操作", from: "murmur" } }];
    const bad = takeNonce(headers, act, params);
    if (bad) return fail(403, "confirm_invalid", bad);

    if (act === "access_set") {
      const p = b.patch || {};
      const keys = Object.keys(p);
      if (!keys.length) return fail(400, "bad_request", "patch 是空的");
      for (const k of keys) {
        if (!SETTING_KEYS.includes(k)) return fail(400, "bad_key", "不认识的设置:" + k);
        if (k === "phase") { if (p.phase !== "closed" && p.phase !== "public") return fail(400, "bad_value", "phase 只能是 closed / public"); continue; }
        if (k === "accepting" || k === "auto_release") { if (typeof p[k] !== "boolean") return fail(400, "bad_value", k + " 要 true / false"); continue; }
        const e = checkNum(k, p[k]); if (e) return fail(400, "out_of_range", e);
      }
      const next = { ...st.settings, ...p };
      if (!(next.budget_alert_ratio < next.budget_stop_ratio)) return fail(400, "out_of_range", "告警比例要小于停止比例");
      // FIX2 B7:审计同服务端 murmur_access_set —— 存整行前后值(去掉 updated_at / updated_by),页面自己挑出改了的格子
      const row = (x) => { const o = { ...x }; delete o.updated_at; delete o.updated_by; return o; };
      const before = row(st.settings);
      // FIX2 B1(同服务端 murmur_access_set):内测 → 公测那一刻,现有待审(new、未标)一并标 eligible,回 marked_eligible
      let marked = 0;
      if (st.settings.phase === "closed" && next.phase === "public") {
        st.requests.forEach((r) => { if (r.status === "new" && !r.eligible_at) { r.eligible_at = new Date().toISOString(); marked++; } });
        st.counts.pending_login = (st.counts.pending_login || 0) + marked;
        st.counts.pending_review = Math.max(0, (st.counts.pending_review || 0) - marked);
      }
      Object.assign(st.settings, p, { updated_at: new Date().toISOString(), updated_by: ADMIN });
      audit("access_set", before, row(st.settings));
      return [200, { ok: true, marked_eligible: marked, settings: { ...st.settings } }];
    }
    if (act === "cohort_quotas_set") {
      if (!st.quotas[b.cohort]) return fail(400, "bad_cohort", "cohort 只能是 closed / public");
      const p = b.patch || {};
      for (const k of Object.keys(p)) {
        if (!QUOTA_KEYS.includes(k)) return fail(400, "bad_key", "不认识的额度:" + k);
        const e = checkNum(k, p[k]); if (e) return fail(400, "out_of_range", e);
      }
      const before = { cohort: b.cohort, ...st.quotas[b.cohort] };      // FIX2 B7:整行(同服务端)
      Object.assign(st.quotas[b.cohort], p);
      audit("cohort_quotas_set", before, { cohort: b.cohort, ...st.quotas[b.cohort] });
      return [200, { ok: true }];
    }
    if (act === "waitlist_release") {
      const n = Number(b.n);
      if (!Number.isInteger(n) || n < 1 || n > 500) return fail(400, "out_of_range", "n 要在 1–500 之间");
      const s = st.settings, b2 = st.budget.site;
      const stopped = s.site_budget_micro_usd > 0 && (b2.spent_micro_usd + b2.reserved_micro_usd) / s.site_budget_micro_usd >= s.budget_stop_ratio;
      const k = stopped ? 0 : Math.min(n, st.counts.waitlisted, room(s), Math.max(0, s.release_daily_max - st.counts.released_today));
      let left = k;
      st.requests.forEach((r) => { if (left > 0 && r.status === "waitlisted") { r.status = "approved"; r.has_seat = true; r.handled_by = ADMIN; r.handled_at = new Date().toISOString(); left--; } });
      st.counts.waitlisted -= k; st.counts.released_today += k;
      if (s.phase === "public") st.counts.public += k; else st.counts.closed += k;
      // FIX2 B7:原因回服务端的英文码(murmur_waitlist_release:budget / public_cap / closed_cap / daily_max;候补放完了是 null),页面负责翻成中文
      const code = stopped ? "budget" : room(s) <= 0 && k < n ? (s.phase === "public" ? "public_cap" : "closed_cap")
                 : k < n && st.counts.released_today >= s.release_daily_max ? "daily_max" : null;
      audit("waitlist_release", { asked: n, daily_left: s.release_daily_max - st.counts.released_today + k },
            { released: k, skipped_no_identity: 0, declined: 0, stopped: code });
      return [200, { ok: true, released: k, stopped: code, reason: code }];
    }
    if (act === "staff_add") {
      const email = String(b.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "bad_email", "邮箱不对");
      if (st.staff.some((x) => x.email === email)) return [200, { ok: true, existed: true }];
      st.staff.push({ user_id: uid(st.staff.length + 1), email, added_at: new Date().toISOString(), added_by: ADMIN });
      st.counts.staff = st.staff.length;
      audit("staff_add", {}, { email }, email);
      return [200, { ok: true }];
    }
    if (act === "staff_remove") {
      const i = st.staff.findIndex((x) => x.user_id === b.user_id);
      if (i < 0) return fail(404, "not_found", "staff 名单里没有这个人");
      const [gone] = st.staff.splice(i, 1);
      st.counts.staff = st.staff.length;
      audit("staff_remove", { email: gone.email }, {}, gone.email);
      return [200, { ok: true }];
    }
    return fail(400, "bad_request", "不认识的操作");
  }

  // method / path(去掉 /functions/v1/murmur 前缀)/ 请求体对象 / 请求头(小写键)→ [状态码, JSON]
  function route(method, p, body, headers = {}) {
    let out;
    if (method === "POST" && p === "/admin/config/challenge") {
      const n = crypto.randomBytes(32).toString("hex");
      nonces.set(n, { action: String((body || {}).action || ""), params: stable((body || {}).params || {}), used: false, exp: Date.now() + 300000 });
      out = [200, { nonce: n, expires_at: new Date(Date.now() + 300000).toISOString() }];
    } else if (method === "POST" && p === "/admin/action") {
      out = action(body || {}, headers);
    } else if (method === "GET" && p === "/admin/stats") {
      out = [200, { admin: ADMIN, server_time: new Date().toISOString(), overview: {}, users: [], anomalies: [], plans: [],
                    audit: st.audit.slice(), invites: [], daily: [], features: [], feature_totals: [], apis: {} }];
    } else if (method === "GET" && p === "/admin/access-requests") {
      const c = { new: 0, waitlisted: 0, approved: 0, declined: 0, total: st.requests.length };
      st.requests.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
      // FIX2 B2 / B6:同服务端 —— 「新」拆成等审核 / 等首次登录(eligible_at 非空)
      c.new_login = st.requests.filter((r) => r.status === "new" && r.eligible_at).length;
      c.new_review = c.new - c.new_login;
      out = [200, { requests: st.requests.map((r) => ({ ...r })), counts: c }];
    } else if (method === "GET" && p === "/admin/config") {
      out = [403, { error: { message: "假服务不带配置块", code: "not_admin" } }];     // 配置块整块藏起来,截图只看开放阶段
    } else {
      out = [404, { error: { message: "没有这个路由", code: "no_route" } }];
    }
    log.push({ method, path: p, action: body && body.action, status: out[0], confirm: headers["x-admin-confirm"] || null });
    return out;
  }
  return { route, state: st, log, nonces };
}

// ── 页面 + 假 API 的本机服务(只听 127.0.0.1)────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
export function servePage(fake, port = 0, htmlPath = path.join(HERE, "..", "index.html")) {
  // SEC-M8 之后脚本在 admin.js、样式在 admin.css,页面 CSP 是 script-src 'self'(不放 unsafe-inline):
  //   HOST 只在内存里换进 admin.js;假会话也不能再用内联 <script> 塞(会被 CSP 挡),改由同源的 /fake-session.js
  //   在 admin.js 之前写进 sessionStorage。index.html 的 CSP 一个字不动 —— 冒烟跑的就是线上那条 CSP。
  const dir = path.dirname(htmlPath);
  const page = () => {
    const h = fs.readFileSync(htmlPath, "utf8");
    const out = h.replace('<script src="admin.js"></script>', '<script src="fake-session.js"></script>\n<script src="admin.js"></script>');
    if (out === h) throw new Error("index.html 里没找到 <script src=\"admin.js\"> 那一行");
    return out;
  };
  const js = () => {
    const a = fs.readFileSync(path.join(dir, "admin.js"), "utf8");
    const out = a.replace(/var HOST = "https:\/\/[^"]+";/, "var HOST = location.origin;");
    if (out === a) throw new Error("admin.js 里没找到 var HOST = … 那一行");
    return out;
  };
  const sessJs = () => {
    const sess = { access_token: "fake-access", refresh_token: "fake-refresh", token_type: "bearer",
                   expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return "try { sessionStorage.setItem(\"murmur.admin.session\", " + JSON.stringify(JSON.stringify(sess)) + "); } catch (e) {}\n";
  };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (code, obj, type) => {
      res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
    };
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) return send(200, page(), "text/html; charset=utf-8");
    if (req.method === "GET" && u.pathname === "/admin.js") return send(200, js(), "text/javascript; charset=utf-8");
    if (req.method === "GET" && u.pathname === "/fake-session.js") return send(200, sessJs(), "text/javascript; charset=utf-8");
    if (req.method === "GET" && u.pathname === "/admin.css") return send(200, fs.readFileSync(path.join(dir, "admin.css"), "utf8"), "text/css; charset=utf-8");
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { return send(400, { error: { message: "请求体不是 JSON" } }); }
      if (u.pathname === "/auth/v1/token") return send(200, { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 });
      const pre = "/functions/v1/murmur";
      if (!u.pathname.startsWith(pre)) return send(404, { error: { message: "没有这个路由" } });
      const hdr = {}; Object.keys(req.headers).forEach((k) => { hdr[k.toLowerCase()] = String(req.headers[k]); });
      const [code, out] = fake.route(req.method, u.pathname.slice(pre.length), body, hdr);
      send(code, out);
    });
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || 8790);
  const fake = createFake(process.argv[3] || "closed");
  const srv = await servePage(fake, port);
  console.log("假服务:http://127.0.0.1:" + srv.address().port + "/(场景 " + (process.argv[3] || "closed") + ",Ctrl-C 停)");
}
