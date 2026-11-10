/* Scouting Roster : serveur (Cloudflare Worker + base D1).
   - comptes personnels (e-mail + mot de passe, cookie signé)
   - documents : tout est privé, chaque compte a son propre catalogue et ses propres simulations
   - lecture d'une page web à partir d'un lien (API officielle de Liquipedia, sinon lecture directe)
   - lecture du contenu par Gemini (texte ou captures) */

const SHARED = ["jeux", "evenements", "joueurs", "demandes", "config"];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC_BYTES = 600000;
const SESSION_DAYS = 30;
const LIQUIPEDIA_PARSE_GAP_MS = 30000; // règle Liquipedia : 1 lecture de page par 30 s
const PAGE_CACHE_MS = 12 * 3600 * 1000;
const MAX_PAGE_CHARS = 60000;
const MAX_FILTERED_CHARS = 100000;
const MAX_CACHED_CHARS = 900000;
const IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll)",
  "CREATE TABLE IF NOT EXISTS versions (coll TEXT PRIMARY KEY, v INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS page_cache (url TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, who TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, who))",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)"
];
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(function (s) { return env.DB.prepare(s); })).catch(function (e) { schemaReady = null; throw e; });
  return schemaReady;
}

/* ---------- utilitaires ---------- */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, headers || {}) });
}
function fail(status, code, message) { return json({ error: code, message: message }, status); }
function b64u(bytes) {
  var s = ""; bytes = new Uint8Array(bytes);
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uToStr(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  var bin = atob(s), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function strToB64u(str) { return b64u(new TextEncoder().encode(str)); }
function slugify(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
async function hmac(secret, data) {
  var key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  var len = Math.max(a.length, b.length), diff = a.length ^ b.length;
  for (var i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  var bin = atob(s), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hashPw(pw, salt) {
  var key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return b64u(bits);
}
function validEmail(e) { return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
function today() { return new Date().toISOString().slice(0, 10); }

/* ---------- session ---------- */
async function makeSession(env, name, uid) {
  var payload = strToB64u(JSON.stringify({ n: name, u: uid, e: Date.now() + SESSION_DAYS * 86400000 }));
  return payload + "." + (await hmac(env.SESSION_SECRET, payload));
}
async function readSession(request, env) {
  var m = /(?:^|;\s*)sr_session=([^;]+)/.exec(request.headers.get("cookie") || "");
  if (!m || !env.SESSION_SECRET) return null;
  var parts = m[1].split(".");
  if (parts.length !== 2) return null;
  var good = await hmac(env.SESSION_SECRET, parts[0]);
  if (!safeEqual(good, parts[1])) return null;
  try {
    var p = JSON.parse(b64uToStr(parts[0]));
    if (!p || !p.u || !p.e || p.e < Date.now()) return null;
    return { uid: String(p.u), name: String(p.n || "") };
  } catch (e) { return null; }
}
function cookieHeader(value, request, maxAge) {
  var secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return "sr_session=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + secure;
}

/* ---------- chemins autorisés ---------- */
function goodId(id) { return ID_RE.test(id) && id !== "." && id !== ".."; }
function parsePath(path, uid) {
  var p = String(path || "").split("/");
  if (p.length === 2 && SHARED.indexOf(p[0]) >= 0 && goodId(p[1])) return { coll: uid + "/" + p[0], id: p[1] };
  if (p.length === 4 && p[0] === "data" && p[1] === "users" && p[2] === uid && goodId(p[3])) return { coll: "data/users/" + uid, id: p[3] };
  return null;
}
/* nom côté page -> nom interne (toujours rangé sous le compte) */
function collInternal(name, uid) {
  if (SHARED.indexOf(name) >= 0) return uid + "/" + name;
  if (name === "data/users/" + uid) return name;
  return null;
}

/* ---------- lecture d'une page : HTML vers texte ---------- */
function decodeEntities(s) {
  var map = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", euro: "€", pound: "£", times: "×" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
    if (e[0] === "#") {
      var n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; } catch (x) { return ""; }
    }
    return Object.prototype.hasOwnProperty.call(map, e.toLowerCase()) ? map[e.toLowerCase()] : m;
  });
}
function htmlToText(html) {
  var h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|tr|table|section|article|h[1-6]|dl|dd|dt|caption)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  h = decodeEntities(h);
  var lines = h.split("\n").map(function (l) { return l.replace(/[ \t ]+/g, " ").replace(/(\|\s*)+$/, "").trim(); }).filter(function (l) { return l && l !== "|"; });
  return lines.join("\n");
}

/* ---------- lecture d'une page : accès ---------- */
function blockedHost(host, env) {
  if (env.ALLOW_PRIVATE_FETCH === "1") return false;
  host = host.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host.indexOf(":") >= 0 || host.indexOf("[") >= 0) return true;
  return false;
}
function userAgent(env) { return "ScoutingRoster/1.0 (outil interne d'une association esport; contact: " + (env.CONTACT || "non renseigné") + ")"; }

async function robotsAllows(origin, path, env) {
  try {
    var res = await fetch(origin + "/robots.txt", { headers: { "user-agent": userAgent(env) }, signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (!res.ok) return true;
    var lines = (await res.text()).split(/\r?\n/), groups = [], cur = null;
    lines.forEach(function (raw) {
      var line = raw.replace(/#.*/, "").trim(); if (!line) return;
      var i = line.indexOf(":"); if (i < 0) return;
      var k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
      if (k === "user-agent") { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
      else if ((k === "allow" || k === "disallow") && cur) cur.rules.push({ allow: k === "allow", p: v });
    });
    var specific = groups.filter(function (g) { return g.agents.some(function (a) { return a && a !== "*" && "scoutingroster".indexOf(a) >= 0; }); });
    var use = specific.length ? specific : groups.filter(function (g) { return g.agents.indexOf("*") >= 0; });
    var best = null;
    use.forEach(function (g) { g.rules.forEach(function (r) { if (r.p && path.indexOf(r.p) === 0 && (!best || r.p.length >= best.p.length)) best = r; }); });
    return !best || best.allow;
  } catch (e) { return true; }
}

async function readLiquipedia(u, env) {
  var segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) throw { status: 422, code: "unreadable", message: "Lien Liquipedia incomplet : ajoute le nom de la page." };
  var wiki = segs[0], title = decodeURIComponent(segs.slice(1).join("/"));
  var last = await env.DB.prepare("SELECT v FROM meta WHERE k='liqui_last_parse'").first();
  var gap = Number(env.LIQUIPEDIA_GAP_MS) || LIQUIPEDIA_PARSE_GAP_MS; // réglable seulement pour les tests
  var wait = last ? gap - (Date.now() - Number(last.v)) : 0;
  if (wait > 0) throw { status: 429, code: "rate_limited", message: "Liquipedia limite les lectures à une toutes les 30 secondes. Réessaie dans " + Math.ceil(wait / 1000) + " s." };
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES('liqui_last_parse',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(Date.now())).run();
  var base = env.LIQUIPEDIA_BASE || "https://liquipedia.net";
  var api = base + "/" + encodeURIComponent(wiki) + "/api.php?action=parse&format=json&prop=text&redirects=1&disablelimitreport=1&disabletoc=1&page=" + encodeURIComponent(title);
  var res = await fetch(api, { headers: { "user-agent": userAgent(env), "accept-encoding": "gzip" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw { status: 422, code: "unreadable", message: "Liquipedia a refusé la lecture (code " + res.status + ")." };
  var data = await res.json();
  if (data && data.error) throw { status: 422, code: "unreadable", message: "Page introuvable sur Liquipedia." };
  var html = data && data.parse && data.parse.text && data.parse.text["*"];
  if (!html) throw { status: 422, code: "unreadable", message: "Liquipedia n'a rien renvoyé pour cette page." };
  return { text: htmlToText(html), source: "liquipedia-api" };
}

async function readWeb(u, env) {
  if (!(await robotsAllows(u.origin, u.pathname + u.search, env))) throw { status: 422, code: "unreadable", message: "Ce site interdit la lecture automatique." };
  var res = await fetch(u.toString(), { headers: { "user-agent": userAgent(env), accept: "text/html,application/xhtml+xml,text/plain;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw { status: 422, code: "unreadable", message: "Le site a refusé la lecture (code " + res.status + ")." };
  var ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct && !/text\/|html|xml/.test(ct)) throw { status: 422, code: "unreadable", message: "Ce lien n'est pas une page web lisible." };
  var raw = (await res.text()).slice(0, 2500000);
  var text = /html|xml/.test(ct) || /<html|<body/i.test(raw.slice(0, 2000)) ? htmlToText(raw) : raw;
  var head = text.slice(0, 1500).toLowerCase();
  if (text.length < 300 || (text.length < 2000 && /just a moment|enable javascript|captcha|access denied|verify you are human/.test(head)))
    throw { status: 422, code: "unreadable", message: "La page est vide ou protégée (chargée par script ou derrière une vérification)." };
  return { text: text, source: "web" };
}

/* Pages de listes (tous les tournois d'un tier, sur plusieurs années) : on ne garde que les lignes des années demandées. */
function keepYears(text, yearsParam) {
  var ys = String(yearsParam || "").split(",").map(function (s) { return s.trim(); }).filter(function (s) { return /^\d{4}$/.test(s); }).slice(0, 4);
  if (!ys.length) return text.slice(0, MAX_PAGE_CHARS);
  var re = new RegExp("\\b(" + ys.join("|") + ")\\b");
  var out = [], n = 0;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { out.push(lines[i]); n += lines[i].length + 1; if (n > MAX_FILTERED_CHARS) break; }
  }
  return out.join("\n");
}

async function readPage(rawUrl, env, years) {
  var u;
  try { u = new URL(String(rawUrl || "").trim()); } catch (e) { throw { status: 400, code: "bad_request", message: "Lien invalide." }; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw { status: 400, code: "bad_request", message: "Lien invalide." };
  if (blockedHost(u.hostname, env)) throw { status: 400, code: "bad_request", message: "Adresse non autorisée." };
  var key = u.toString();
  var c = await env.DB.prepare("SELECT text, source, fetched_at FROM page_cache WHERE url=?").bind(key).first();
  if (c && Date.now() - c.fetched_at < PAGE_CACHE_MS) return { text: keepYears(c.text, years), source: c.source, cached: true };
  var host = u.hostname.toLowerCase();
  var out = (host === "liquipedia.net" || host.endsWith(".liquipedia.net") || (env.LIQUIPEDIA_TEST_HOST && host === env.LIQUIPEDIA_TEST_HOST)) ? await readLiquipedia(u, env) : await readWeb(u, env);
  var full = out.text.slice(0, MAX_CACHED_CHARS);
  await env.DB.prepare("INSERT INTO page_cache(url,text,source,fetched_at) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET text=excluded.text, source=excluded.source, fetched_at=excluded.fetched_at").bind(key, full, out.source, Date.now()).run();
  return { text: keepYears(full, years), source: out.source };
}

/* ---------- lecture par Gemini ---------- */
async function askGemini(env, prompt, images, opts) {
  opts = opts || {};
  if (!env.GEMINI_API_KEY) throw { status: 503, code: "not_configured", message: "La clé Gemini n'est pas configurée sur le serveur." };
  var models = String(env.GEMINI_MODEL || "gemini-3.5-flash,gemini-3.8-flash,gemini-3.5-flash-lite").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  var base = env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  var parts = [{ text: prompt }];
  (images || []).forEach(function (im) { parts.push({ inlineData: { mimeType: im.mime, data: im.data } }); });
  var body = { contents: [{ role: "user", parts: parts }], generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 16384 } };
  // Recherche web (annonces officielles) : Gemini ne sait pas répondre en JSON strict avec la recherche, le navigateur lit le JSON dans le texte.
  if (opts.search) { body.tools = [{ google_search: {} }]; delete body.generationConfig.responseMimeType; }
  var res = null;
  // Google retire des modèles de temps en temps : si l'un répond 404 (retiré) ou 5xx (surchargé), on essaie le suivant.
  for (var mi = 0; mi < models.length; mi++) {
    // Un modèle surchargé (503) répond souvent bien à la deuxième tentative.
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(base + "/v1beta/models/" + encodeURIComponent(models[mi]) + ":generateContent", {
          method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.search ? 100000 : (models.length > 1 ? 50000 : 110000))
        });
      } catch (e) { res = null; break; }
      if (res.status !== 503 && res.status !== 500 && res.status !== 504) break;
      if (attempt === 0) await new Promise(function (ok) { setTimeout(ok, Number(env.GEMINI_RETRY_MS) || 2500); });
    }
    if (res && res.status !== 404 && res.status < 500) break;
    if (mi === models.length - 1) break;
  }
  if (!res) throw { status: 502, code: "upstream_error", message: "Gemini ne répond pas. Réessaie dans un instant." };
  if (res.status === 503 || res.status === 500 || res.status === 504) throw { status: 503, code: "overloaded", message: "Gemini est très sollicité en ce moment." };
  if (res.status === 429) throw { status: 429, code: "rate_limited", message: "La limite gratuite de Gemini est atteinte. Réessaie dans quelques minutes." };
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    var t = ""; try { t = (await res.text()).slice(0, 300); } catch (e) {}
    throw { status: 502, code: "upstream_error", message: "Gemini a refusé la demande (" + res.status + "). Vérifie la clé et le modèle. " + t };
  }
  if (!res.ok) throw { status: 502, code: "upstream_error", message: "Gemini ne répond pas (" + res.status + ")." + (res.status === 404 ? " Le modèle est peut-être retiré : change GEMINI_MODEL." : "") };
  var data = await res.json();
  var cand = data && data.candidates && data.candidates[0];
  if (!cand || !cand.content) throw { status: 422, code: "refused", message: "Gemini n'a pas voulu lire ce contenu." };
  var text = (cand.content.parts || []).map(function (p) { return p.text || ""; }).join("");
  if (!text.trim()) throw { status: 422, code: "empty_completion", message: "Gemini n'a rien renvoyé." };
  return { text: text, truncated: cand.finishReason === "MAX_TOKENS" };
}

/* ---------- lecture par Claude (si une clé Anthropic est configurée : plus rapide et plus stable) ---------- */
async function askClaude(env, prompt, images, opts) {
  opts = opts || {};
  var base = env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  var model = opts.search ? (env.ANTHROPIC_MODEL_SEARCH || "claude-sonnet-5-5") : (env.ANTHROPIC_MODEL || "claude-haiku-5-5");
  var content = [];
  (images || []).forEach(function (im) { content.push({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data } }); });
  content.push({ type: "text", text: prompt });
  var body = { model: model, max_tokens: 16000, system: "Tu réponds uniquement par l'objet JSON demandé, sans texte avant ni après, sans bloc de code.", messages: [{ role: "user", content: content }] };
  if (opts.search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  var key = String(env.ANTHROPIC_API_KEY || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_\-]{20,}$/.test(key))
    throw { status: 502, code: "upstream_error", message: "La clé Anthropic enregistrée dans Cloudflare contient des caractères invalides (" + key.length + " caractères). Recopie-la en entier depuis la console Anthropic, sans guillemets ni points de suspension, ou crée-en une nouvelle." };
  var texts = [], truncated = false, stop = "", tries = 0;
  while (tries++ < 6) {
    /* dernier tour : plus de recherche, il faut répondre avec ce qui a été trouvé */
    if (tries === 6 && body.tools) body.tool_choice = { type: "none" };
    var res;
    try {
      res = await fetch(base + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.search ? 110000 : 100000) });
    } catch (e) {
      var why = e && e.name === "TimeoutError" ? "délai dépassé" : String((e && e.message) || e).slice(0, 120);
      throw { status: 502, code: "upstream_error", message: "Claude ne répond pas (" + why + "). Réessaie dans un instant." };
    }
    if (res.status === 429) throw { status: 429, code: "rate_limited", message: "La limite de l'API Claude est atteinte. Réessaie dans quelques instants." };
    if (res.status === 529 || res.status >= 500) throw { status: 503, code: "overloaded", message: "Claude est très sollicité en ce moment." };
    if (!res.ok) {
      var t = ""; try { t = (await res.text()).slice(0, 300); } catch (e) {}
      throw { status: 502, code: "upstream_error", message: "Claude a refusé la demande (" + res.status + "). Vérifie la clé et le crédit du compte Anthropic. " + t };
    }
    var data = await res.json();
    stop = data.stop_reason || "";
    var blocks = data.content || [];
    texts.push(blocks.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text || ""; }).join(""));
    truncated = stop === "max_tokens";
    /* recherche web longue : Claude met sa réponse en pause, on lui demande de continuer */
    if (stop === "pause_turn" && blocks.length) { body.messages = body.messages.concat([{ role: "assistant", content: blocks }]); continue; }
    break;
  }
  var text = texts.join("");
  if (!text.trim()) throw { status: 422, code: "empty_completion", message: "Claude n'a rien renvoyé (arrêt : " + (stop || "inconnu") + "). Relance l'analyse." };
  return { text: text, truncated: truncated };
}
function askModel(env, prompt, images, opts) { return env.ANTHROPIC_API_KEY ? askClaude(env, prompt, images, opts) : askGemini(env, prompt, images, opts); }

/* ---------- guides par jeu (Google Sheet "Banque de données Scouting Roster") ---------- */
const GUIDE_CACHE_MS = 3 * 3600 * 1000;
const GUIDE_MAX_CHARS = 30000;
const GUIDE_GAMES = [
  { tab: "Guide Valorant", re: /\bvalorant\b/ },
  { tab: "Guide Apex Legends", re: /\bapex\b/ },
  { tab: "Guide Rainbow Six Siege", re: /\brainbow six\b|\br6\b/ },
  { tab: "Guide League of Legends", re: /\bleague of legends\b|\blol\b/ },
  { tab: "Guide Counter-Strike 2", re: /\bcounter[- ]?strike\b|\bcs2\b|\bcsgo\b/ },
  { tab: "Guide Call of Duty", re: /\bcall of duty\b|\bcod\b|\bwarzone\b/ },
  { tab: "Guide Rocket League", re: /\brocket league\b/ },
  { tab: "Guide Fortnite", re: /\bfortnite\b/ },
  { tab: "Guide Halo", re: /\bhalo\b/ },
  { tab: "Guide Dota 2", re: /\bdota\b/ },
  { tab: "Guide Overwatch 2", re: /\boverwatch\b/ },
  { tab: "Guide Marvel Rivals", re: /\bmarvel rivals\b/ },
  { tab: "Guide PUBG", re: /\bpubg\b/ },
  { tab: "Guide EA Sports FC", re: /\bea sports fc\b|\bfc ?2\d\b|\bfifa\b/ },
  { tab: "Guide Street Fighter 6", re: /\bstreet fighter\b|\bsf6\b/ },
  { tab: "Guide Tekken 8", re: /\btekken\b/ },
  { tab: "Guide Super Smash Bros", re: /\bsmash\b/ },
  { tab: "Guide Teamfight Tactics", re: /\bteamfight\b|\btft\b/ },
  { tab: "Guide Wild Rift", re: /\bwild rift\b/ },
  { tab: "Guide Mobile Legends", re: /\bmobile legends\b|\bmlbb\b/ },
  { tab: "Guide Free Fire", re: /\bfree fire\b/ },
  { tab: "Guide Brawl Stars", re: /\bbrawl stars\b/ },
  { tab: "Guide Clash Royale", re: /\bclash royale\b/ },
  { tab: "Guide Age of Empires II", re: /\bage of empires\b|\baoe\b/ },
  { tab: "Guide Starcraft II", re: /\bstarcraft\b|\bsc2\b/ },
  { tab: "Guide Trackmania", re: /\btrackmania\b/ }
];
function guideMatches(text) {
  var t = String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  var hits = GUIDE_GAMES.filter(function (g) { return g.re.test(t); }).map(function (g) { return g.tab; });
  if (hits.indexOf("Guide Wild Rift") >= 0) hits = hits.filter(function (h) { return h !== "Guide League of Legends"; });
  return hits;
}
function parseCsv(txt) {
  var rows = [], row = [], cell = "", q = false;
  for (var i = 0; i < txt.length; i++) {
    var ch = txt[i];
    if (q) {
      if (ch === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && txt[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function readGuide(env, tab) {
  var id = env.GUIDE_SHEET_ID;
  if (!id) throw { status: 503, code: "not_configured", message: "Le Google Sheet des guides n'est pas configuré." };
  var key = "guide:" + id + ":" + tab;
  var c = await env.DB.prepare("SELECT text, fetched_at FROM page_cache WHERE url=?").bind(key).first();
  if (c && Date.now() - c.fetched_at < GUIDE_CACHE_MS) return c.text;
  var res;
  try {
    res = await fetch("https://docs.google.com/spreadsheets/d/" + encodeURIComponent(id) + "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(tab), { headers: { "user-agent": userAgent(env) }, signal: AbortSignal.timeout(15000), redirect: "follow" });
  } catch (e) {
    if (c) return c.text;
    throw { status: 502, code: "upstream_error", message: "Le Google Sheet ne répond pas." };
  }
  var body = res.ok ? await res.text() : "";
  if (!res.ok || /^\s*<(!doctype|html)/i.test(body)) {
    if (c) return c.text;
    throw { status: 502, code: "upstream_error", message: "Lecture du Google Sheet impossible. Vérifie qu'il est partagé en lecture par lien." };
  }
  var text = parseCsv(body).map(function (r) {
    var a = (r[0] || "").trim(), b = (r[1] || "").trim();
    return a && b ? a + " : " + b : (a || b);
  }).filter(Boolean).join("\n").slice(0, GUIDE_MAX_CHARS);
  if (!text) throw { status: 404, code: "not_found", message: "Onglet vide ou introuvable : " + tab };
  await env.DB.prepare("INSERT INTO page_cache(url,text,source,fetched_at) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET text=excluded.text, source=excluded.source, fetched_at=excluded.fetched_at").bind(key, text, "sheet", Date.now()).run();
  return text;
}
/* Ajoute au prompt le guide du jeu cité (jamais bloquant : sans guide, la demande part telle quelle). */
async function withGuide(env, prompt) {
  try {
    var tabs = guideMatches(prompt).slice(0, 2);
    if (!tabs.length) return prompt;
    var parts = [];
    for (var i = 0; i < tabs.length; i++) parts.push("### " + tabs[i] + "\n" + await readGuide(env, tabs[i]));
    return "INFORMATIONS DE RÉFÉRENCE (Google Sheet « Banque de données Scouting Roster », mis à jour par Majin). C'est ta base : elle contient déjà le calendrier 2026 (Pro, Challenger, Amateur), les cash prizes et les vainqueurs. Utilise-la d'abord. Si tu fais des recherches web, 3 au maximum, sers-t'en uniquement pour compléter ou vérifier (dates 2027 annoncées, résultats récents, informations notées « non lu »), sans refaire ce que le guide donne déjà. Ne cherche jamais une information déjà présente. Si une information reste introuvable, ne l'invente pas.\n\n" + parts.join("\n\n") + "\n\n--- DEMANDE ---\n" + prompt;
  } catch (e) { return prompt; }
}

/* ---------- quotas ---------- */
async function countUse(env, who) {
  var r = await env.DB.prepare("SELECT n FROM usage WHERE day=? AND who=?").bind(today(), who).first();
  return r ? Number(r.n) : 0;
}
async function addUse(env, who) {
  await env.DB.prepare("INSERT INTO usage(day,who,n) VALUES(?,?,1) ON CONFLICT(day,who) DO UPDATE SET n=n+1").bind(today(), who).run();
}

/* ---------- routes ---------- */
async function readJson(request, maxBytes) {
  var text = await request.text();
  if (text.length > maxBytes) throw { status: 413, code: "too_large", message: "Contenu trop volumineux." };
  try { return JSON.parse(text); } catch (e) { throw { status: 400, code: "bad_request", message: "JSON invalide." }; }
}

async function handleApi(request, env, url) {
  var path = url.pathname, method = request.method;

  if ((path === "/api/login" || path === "/api/signup") && method === "POST") {
    if (!env.SESSION_SECRET) return fail(503, "not_configured", "Le serveur n'est pas configuré (SESSION_SECRET manquant).");
    var ip = request.headers.get("cf-connecting-ip") || "local";
    var hour = new Date().toISOString().slice(0, 13);
    var b = await readJson(request, 4000);
    var email = String((b && b.email) || "").trim().toLowerCase(), pw = String((b && b.password) || "");
    if (!validEmail(email)) return fail(400, "bad_request", "Adresse e-mail invalide.");
    if (pw.length < 8 || pw.length > 200) return fail(400, "bad_request", "Le mot de passe doit faire au moins 8 caractères.");
    var eh = (await hmac(env.SESSION_SECRET, "mail:" + email)).slice(0, 16);
    if ((await countUse(env, "login:" + ip + ":" + hour)) >= 20 || (await countUse(env, "loginmail:" + eh + ":" + hour)) >= 10)
      return fail(429, "rate_limited", "Trop d'essais. Réessaie dans une heure.");
    if (path === "/api/signup") {
      if (env.INVITE_CODE && !safeEqual(String((b && b.code) || ""), env.INVITE_CODE)) return fail(403, "forbidden", "Code d'invitation incorrect.");
      var nm = String((b && b.name) || "").trim().slice(0, 40);
      if (!nm) return fail(400, "bad_request", "Indique ton prénom ou le nom du compte.");
      if ((await countUse(env, "signup:" + ip + ":" + hour)) >= 5) return fail(429, "rate_limited", "Trop de créations de compte depuis cette connexion. Réessaie plus tard.");
      var exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
      if (exists) return fail(409, "exists", "Un compte existe déjà avec cette adresse. Connecte-toi.");
      var salt = crypto.getRandomValues(new Uint8Array(16)), idb = crypto.getRandomValues(new Uint8Array(10));
      var newId = "u-" + Array.prototype.map.call(idb, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      var h1 = await hashPw(pw, salt);
      await env.DB.prepare("INSERT INTO users(id,email,name,salt,hash,created_at) VALUES(?,?,?,?,?,?)").bind(newId, email, nm, b64u(salt), h1, Date.now()).run();
      await addUse(env, "signup:" + ip + ":" + hour);
      var tok0 = await makeSession(env, nm, newId);
      return json({ ok: true, name: nm }, 200, { "set-cookie": cookieHeader(tok0, request, SESSION_DAYS * 86400) });
    }
    var u = await env.DB.prepare("SELECT id, name, salt, hash FROM users WHERE email=?").bind(email).first();
    var got = await hashPw(pw, u ? b64uToBytes(u.salt) : new Uint8Array(16));
    if (!u || !safeEqual(got, u.hash)) {
      await addUse(env, "login:" + ip + ":" + hour); await addUse(env, "loginmail:" + eh + ":" + hour);
      return fail(401, "auth", "E-mail ou mot de passe incorrect.");
    }
    var tok = await makeSession(env, u.name, u.id);
    return json({ ok: true, name: u.name }, 200, { "set-cookie": cookieHeader(tok, request, SESSION_DAYS * 86400) });
  }
  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": cookieHeader("", request, 0) });

  var me = await readSession(request, env);
  if (!me) return fail(401, "auth", "Connexion requise.");

  if (path === "/api/me" && method === "GET") return json({ uid: me.uid, name: me.name });

  if (path === "/api/versions" && method === "GET") {
    var cl = SHARED.concat(["data/users/" + me.uid]), inames = cl.map(function (n) { return collInternal(n, me.uid); });
    var vsql = "SELECT coll, v FROM versions WHERE coll IN (" + inames.map(function () { return "?"; }).join(",") + ")";
    var rows = await env.DB.prepare(vsql).bind(...inames).all();
    var out = {}; (rows.results || []).forEach(function (r) { var k = cl[inames.indexOf(r.coll)]; if (k) out[k] = r.v; });
    return json({ versions: out });
  }

  if (path === "/api/col" && method === "GET") {
    var cname = collInternal(url.searchParams.get("name") || "", me.uid);
    if (!cname) return fail(403, "forbidden", "Accès refusé.");
    var list = await env.DB.prepare("SELECT id, data FROM docs WHERE coll=? ORDER BY id").bind(cname).all();
    var v = await env.DB.prepare("SELECT v FROM versions WHERE coll=?").bind(cname).first();
    return json({ v: v ? v.v : 0, docs: (list.results || []).map(function (r) { return { id: r.id, data: JSON.parse(r.data) }; }) });
  }

  if (path === "/api/doc") {
    var pp = parsePath(url.searchParams.get("path"), me.uid);
    if (!pp) return fail(403, "forbidden", "Accès refusé.");
    var full = pp.coll + "/" + pp.id;
    if (method === "GET") {
      var row = await env.DB.prepare("SELECT data FROM docs WHERE path=?").bind(full).first();
      var vv = await env.DB.prepare("SELECT v FROM versions WHERE coll=?").bind(pp.coll).first();
      return json({ exists: !!row, data: row ? JSON.parse(row.data) : null, v: vv ? vv.v : 0 });
    }
    if (method === "PUT") {
      var doc = await readJson(request, MAX_DOC_BYTES);
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail(400, "bad_request", "Le document doit être un objet.");
      await env.DB.batch([
        env.DB.prepare("INSERT INTO docs(path,coll,id,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").bind(full, pp.coll, pp.id, JSON.stringify(doc), Date.now()),
        env.DB.prepare("INSERT INTO versions(coll,v) VALUES(?,1) ON CONFLICT(coll) DO UPDATE SET v=v+1").bind(pp.coll)
      ]);
      return json({ ok: true });
    }
    return fail(405, "bad_request", "Méthode non autorisée.");
  }

  if (path === "/api/page" && method === "GET") {
    try { return json(await readPage(url.searchParams.get("url"), env, url.searchParams.get("years"))); }
    catch (e) { if (e && e.status) return fail(e.status, e.code, e.message); throw e; }
  }

  if (path === "/api/guide" && method === "GET") {
    var gt = guideMatches(url.searchParams.get("game"));
    if (!gt.length) return fail(404, "not_found", "Aucun guide pour ce jeu.");
    try { return json({ tab: gt[0], text: await readGuide(env, gt[0]) }); }
    catch (e) { if (e && e.status) return fail(e.status, e.code, e.message); throw e; }
  }

  if (path === "/api/ai" && method === "POST") {
    var b2 = await readJson(request, 30000000);
    var prompt = b2 && typeof b2.prompt === "string" ? b2.prompt : "";
    var imgs = Array.isArray(b2 && b2.images) ? b2.images : [];
    if (!prompt || prompt.length > 250000) return fail(400, "bad_request", "Demande vide ou trop longue.");
    if (imgs.length > 6) return fail(400, "image_rejected", "6 images au maximum.");
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i] || IMG_TYPES.indexOf(imgs[i].mime) < 0 || typeof imgs[i].data !== "string" || imgs[i].data.length > 9000000 || !/^[A-Za-z0-9+/=]+$/.test(imgs[i].data))
        return fail(400, "image_rejected", "Image refusée (type ou taille).");
    }
    var cap = Number(env.DAILY_READS || 200), capUser = Number(env.DAILY_READS_PER_USER || 20);
    if ((await countUse(env, "ai:" + me.uid)) >= capUser) return fail(429, "rate_limited", "Tu as atteint ta limite de " + capUser + " lectures par jour. Réessaie demain.");
    if ((await countUse(env, "ai")) >= cap) return fail(429, "rate_limited", "Limite quotidienne de lectures atteinte pour tous les comptes (" + cap + "). Réessaie demain.");
    try {
      var r = await askModel(env, await withGuide(env, prompt), imgs, { search: b2.search === true });
      await addUse(env, "ai"); await addUse(env, "ai:" + me.uid);
      return json(r);
    } catch (e) { if (e && e.status) return fail(e.status, e.code, e.message); throw e; }
  }

  return fail(404, "not_found", "Introuvable.");
}

const SECURITY = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
async function asset(env, request, name, noStore) {
  var res = await env.ASSETS.fetch(new Request(new URL("/" + name, request.url).toString(), { method: "GET" }));
  var h = new Headers(res.headers);
  Object.keys(SECURITY).forEach(function (k) { h.set(k, SECURITY[k]); });
  if (noStore) h.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(request, env) {
    try {
      var url = new URL(request.url);
      await ensureSchema(env);
      if (url.pathname.indexOf("/api/") === 0) return await handleApi(request, env, url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Méthode non autorisée", { status: 405 });
      if (url.pathname === "/" || url.pathname === "/index.html") {
        var me = await readSession(request, env);
        return asset(env, request, me ? "app.html" : "login.html", true);
      }
      if (url.pathname === "/shim.js" || url.pathname === "/login.html") return asset(env, request, url.pathname.slice(1), true);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      return new Response("Introuvable", { status: 404 });
    } catch (e) {
      if (e && e.status) return fail(e.status, e.code || "error", e.message || "Erreur");
      return fail(500, "server", "Erreur du serveur.");
    }
  }
};
