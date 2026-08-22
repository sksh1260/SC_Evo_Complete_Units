import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// 편집 중에는 프런트엔드가 주기적으로 갱신하는 슬라이딩 세션이다.
// 장시간 편집을 보호하면서도, 브라우저를 닫아 둔 세션은 만료된다.
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

function koreaDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 접속 집계는 하나의 Durable Object에서 직렬 처리한다. 따라서 동시 요청에도
// Today/Total 카운터가 덮어써지지 않으며, 관리자만 일별 이력을 읽을 수 있다.
export class VisitorCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async record(visitorId, day) {
    const storage = this.ctx.storage;
    const visitorKey = "visitor:" + visitorId;
    const dayVisitorKey = "day-visitor:" + day + ":" + visitorId;
    const totalKey = "total";
    const dayKey = "day:" + day;
    let total = Number(await storage.get(totalKey) || 0);
    let today = Number(await storage.get(dayKey) || 0);
    const writes = new Map();

    if (!await storage.get(visitorKey)) {
      total += 1;
      writes.set(visitorKey, 1);
      writes.set(totalKey, total);
    }
    if (!await storage.get(dayVisitorKey)) {
      today += 1;
      writes.set(dayVisitorKey, 1);
      writes.set(dayKey, today);
      const days = await storage.get("days") || [];
      if (!days.includes(day)) {
        days.push(day);
        writes.set("days", days.slice(-730));
      }
    }
    // Durable Object storage에는 Map이 아닌 일반 객체로 전달한다.
    // Map은 일부 런타임에서 빈 값으로 처리되어 응답은 성공하지만 집계가 남지 않을 수 있다.
    if (writes.size) await storage.put(Object.fromEntries(writes));
    return { today, total };
  }

  async stats(day) {
    return {
      today: Number(await this.ctx.storage.get("day:" + day) || 0),
      total: Number(await this.ctx.storage.get("total") || 0)
    };
  }

  async history(limit = 90) {
    const storage = this.ctx.storage;
    const days = (await storage.get("days") || []).slice(-Math.max(1, Math.min(limit, 730))).reverse();
    const records = [];
    for (const day of days) records.push({ date: day, visitors: Number(await storage.get("day:" + day) || 0) });
    return { total: Number(await storage.get("total") || 0), records };
  }
}

function base64UrlEncode(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = encoder.encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

async function sign(payload, secret) {
  const encoded = base64UrlEncode(payload);
  return encoded + "." + await hmac(encoded, secret);
}

async function verify(token, secret) {
  const [encoded, received] = String(token || "").split(".");
  if (!encoded || !received || received !== await hmac(encoded, secret)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encoded));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch (_) { return null; }
}

function cors(request, env) {
  const origin = request.headers.get("Origin");
  return origin === env.FRONTEND_ORIGIN ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Vary": "Origin"
  } : {};
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 통계·인증·편집 API는 이전 응답을 브라우저나 중간 캐시에서 재사용하면 안 된다.
      "Cache-Control": "no-store, max-age=0",
      ...headers
    }
  });
}

function redirect(url) { return new Response(null, { status: 302, headers: { Location: url } }); }

function githubHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SC-Evo-Patch-Admin"
  };
}

async function getGithubUser(accessToken) {
  const res = await fetch("https://api.github.com/user", { headers: githubHeaders(accessToken) });
  if (!res.ok) throw new Error("GitHub 사용자 정보를 가져오지 못했습니다.");
  return res.json();
}

function isConfiguredAdmin(login, env) {
  return String(env.ADMIN_GITHUB_LOGINS || "").split(",").map(v => v.trim().toLowerCase()).includes(String(login).toLowerCase());
}

function getBearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function requireAdmin(request, env) {
  const session = await verify(getBearer(request), env.SESSION_SECRET);
  return session && isConfiguredAdmin(session.login, env) ? session : null;
}

function createAdminSession(login, env) {
  return sign({ login, exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS }, env.SESSION_SECRET);
}

function gitHubContentsUrl(env) {
  const [owner, repo] = String(env.GITHUB_REPO || "").split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPO 설정이 올바르지 않습니다.");
  return "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + encodeURIComponent(env.PATCH_FILE || "Patch.csv");
}

function encodeUtf8Base64(text) {
  const bytes = encoder.encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUtf8Base64(base64) {
  const binary = atob(String(base64).replace(/\n/g, ""));
  return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

async function getPatchFromGithub(env) {
  const url = gitHubContentsUrl(env);
  const res = await fetch(url, { headers: githubHeaders(env.GITHUB_REPO_TOKEN) });
  if (res.status === 404) return { csv: "", sha: null };
  if (!res.ok) throw new Error("GitHub에서 Patch.csv를 읽지 못했습니다.");
  const data = await res.json();
  return { csv: decodeUtf8Base64(data.content), sha: data.sha };
}

async function savePatchToGithub(csv, message, env) {
  const existing = await getPatchFromGithub(env);
  const body = {
    message: message || "Update patch history",
    content: encodeUtf8Base64(csv),
    branch: "main"
  };
  if (existing.sha) body.sha = existing.sha;
  const res = await fetch(gitHubContentsUrl(env), {
    method: "PUT",
    headers: { ...githubHeaders(env.GITHUB_REPO_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("GitHub 저장에 실패했습니다: " + await res.text());
  return res.json();
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = await verify(url.searchParams.get("state"), env.SESSION_SECRET);
  if (!code || !state) return new Response("Invalid or expired login request.", { status: 400 });

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return new Response("GitHub login failed.", { status: 401 });
  const user = await getGithubUser(tokenData.access_token);
  if (!isConfiguredAdmin(user.login, env)) return new Response("관리자 권한이 없는 GitHub 계정입니다.", { status: 403 });

  const session = await createAdminSession(user.login, env);
  const frontend = new URL(env.FRONTEND_URL || env.FRONTEND_ORIGIN);
  frontend.searchParams.set("admin_token", session);
  frontend.hash = "patch";
  return redirect(frontend.toString());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers });

    try {
      if (url.pathname === "/auth/login") {
        const state = await sign({ exp: Math.floor(Date.now() / 1000) + 10 * 60 }, env.SESSION_SECRET);
        const authUrl = new URL("https://github.com/login/oauth/authorize");
        authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", url.origin + "/auth/callback");
        authUrl.searchParams.set("scope", "read:user");
        authUrl.searchParams.set("state", state);
        return redirect(authUrl.toString());
      }
      if (url.pathname === "/auth/callback") return handleOAuthCallback(url, env);

      if (url.pathname === "/api/visitors" && request.method === "GET") {
        if (!await requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, headers);
        const stats = await env.VISITOR_COUNTER.getByName("site-visitors").stats(koreaDateKey());
        return json(stats, 200, headers);
      }
      if (url.pathname === "/api/visitors" && request.method === "POST") {
        const body = await request.json();
        const visitorId = String(body && body.visitorId || "");
        if (!/^[A-Za-z0-9_-]{20,96}$/.test(visitorId)) return json({ error: "Invalid visitor" }, 400, headers);
        await env.VISITOR_COUNTER.getByName("site-visitors").record(visitorId, koreaDateKey());
        // 일반 방문자에게는 집계 성공 여부만 반환한다. 수치는 관리자 전용이다.
        return json({ ok: true }, 200, headers);
      }
      if (url.pathname === "/api/admin/visitors" && request.method === "GET") {
        if (!await requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, headers);
        const requestedLimit = Number(url.searchParams.get("limit") || 90);
        const history = await env.VISITOR_COUNTER.getByName("site-visitors").history(requestedLimit);
        return json(history, 200, headers);
      }

      if (url.pathname === "/api/admin" && request.method === "GET") {
        const admin = await requireAdmin(request, env);
        // 정상적인 관리자 확인마다 만료 시간을 새로 부여한다.
        return admin
          ? json({ login: admin.login, token: await createAdminSession(admin.login, env) }, 200, headers)
          : json({ error: "Unauthorized" }, 401, headers);
      }
      if (url.pathname === "/api/patch" && request.method === "GET") {
        if (!await requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, headers);
        const patch = await getPatchFromGithub(env);
        return json({ csv: patch.csv }, 200, headers);
      }
      if (url.pathname === "/api/patch" && request.method === "PUT") {
        const admin = await requireAdmin(request, env);
        if (!admin) return json({ error: "Unauthorized" }, 401, headers);
        const body = await request.json();
        if (typeof body.csv !== "string" || body.csv.length < 5 || body.csv.length > 2_000_000) {
          return json({ error: "Invalid patch data" }, 400, headers);
        }
        const saved = await savePatchToGithub(body.csv, body.message, env);
        return json({ ok: true, commit: saved.commit?.sha, login: admin.login }, 200, headers);
      }
      return json({ error: "Not found" }, 404, headers);
    } catch (error) {
      return json({ error: error.message || "Internal error" }, 500, headers);
    }
  }
};
