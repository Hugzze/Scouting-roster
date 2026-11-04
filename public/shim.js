/* Couche de compatibilité : donne à la page les mêmes outils que dans Claude
   (base de documents, utilisateur, lecture par IA), mais branchés sur ce serveur. */
(function () {
  "use strict";
  window.SR_SITE = true;

  var IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var POLL_MS = 20000;

  function codeFor(status, j) {
    var c = j && j.error;
    if (status === 401) return "session_expired";
    if (status === 403) return "not_granted";
    if (status === 429) return "rate_limited";
    if (c === "auth") return "session_expired";
    return c || "upstream_error";
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, { method: opts.method || "GET", credentials: "same-origin", headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (r.ok) return j;
          if (r.status === 401) { setTimeout(function () { location.reload(); }, 800); }
          var e = { code: codeFor(r.status, j), message: (j && j.message) || "Erreur " + r.status };
          throw e;
        });
      }, function () { throw { code: "upstream_error", message: "Le serveur ne répond pas." }; });
  }

  /* ---------- utilisateur ---------- */
  var meP = api("/api/me").then(function (m) { window.SR_USER = m; return m; });
  var user = {
    id: function () { return meP.then(function (m) { return m.uid; }); },
    isOwner: function () { return Promise.resolve(false); },
    can: function () { return Promise.resolve(true); }
  };
  window.SR_LOGOUT = function () { return api("/api/logout", { method: "POST", body: "{}" }).then(function () { location.reload(); }); };

  /* ---------- base de documents ---------- */
  var subs = [], knownV = {}, polling = false;
  function collOf(path) { var p = path.split("/"); return p.length === 2 ? p[0] : p.slice(0, 3).join("/"); }
  function mkDocs(rows, order, lim) {
    var docs = rows.map(function (r) { return { id: r.id, data: function () { return JSON.parse(JSON.stringify(r.data)); } }; });
    if (order) {
      docs.sort(function (a, b) {
        var x = a.data()[order.field], y = b.data()[order.field];
        x = x == null ? "" : x; y = y == null ? "" : y;
        var c = x < y ? -1 : x > y ? 1 : 0;
        return order.dir === "desc" ? -c : c;
      });
    }
    if (lim) docs = docs.slice(0, lim);
    return { docs: docs };
  }
  function fetchSub(s) {
    if (s.kind === "col") {
      return api("/api/col?name=" + encodeURIComponent(s.coll)).then(function (r) {
        s.v = r.v; var sig = JSON.stringify(r.docs);
        if (s.sig === sig) return; s.sig = sig;
        s.cb(mkDocs(r.docs, s.order, s.lim));
      });
    }
    return api("/api/doc?path=" + encodeURIComponent(s.path)).then(function (r) {
      s.v = r.v; var sig = r.exists ? JSON.stringify(r.data) : "∅";
      if (s.sig === sig) return; s.sig = sig;
      s.cb({ exists: r.exists, data: function () { return r.data ? JSON.parse(JSON.stringify(r.data)) : undefined; }, metadata: { hasPendingWrites: false } });
    });
  }
  function addSub(s) {
    subs.push(s);
    fetchSub(s).catch(function (e) { if (s.err) s.err(e); });
    return function () { subs = subs.filter(function (x) { return x !== s; }); };
  }
  function pollNow() {
    if (polling || !subs.length) return Promise.resolve();
    polling = true;
    return api("/api/versions").then(function (r) {
      var vs = r.versions || {}, jobs = [];
      subs.slice().forEach(function (s) { if ((vs[s.coll] || 0) !== (s.v || 0)) jobs.push(fetchSub(s).catch(function () {})); });
      return Promise.all(jobs);
    }).catch(function () {}).then(function () { polling = false; });
  }
  setInterval(function () { if (!document.hidden) pollNow(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollNow(); });

  function colQuery(name, order, lim) {
    var q = {
      orderBy: function (field, dir) { return colQuery(name, { field: field, dir: dir || "asc" }, lim); },
      limit: function (n) { return colQuery(name, order, n); },
      onSnapshot: function (cb, err) { return addSub({ kind: "col", coll: name, order: order, lim: lim, cb: cb, err: err }); }
    };
    return q;
  }
  var db = {
    collection: function (name) { return colQuery(name, null, null); },
    doc: function (path) {
      return {
        set: function (data) {
          return api("/api/doc?path=" + encodeURIComponent(path), { method: "PUT", body: JSON.stringify(data) }).then(function () { setTimeout(pollNow, 0); });
        },
        onSnapshot: function (cb, err) { return addSub({ kind: "doc", coll: collOf(path), path: path, cb: cb, err: err }); }
      };
    }
  };

  /* ---------- lecture par IA ---------- */
  function tolerantJson(text) {
    var t = String(text || "").trim();
    try { return JSON.parse(t); } catch (e) {}
    var m = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    var a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw null;
  }
  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { reject(new Error("read")); };
      r.readAsDataURL(blob);
    });
  }
  function shrink(file) {
    if (IMG_TYPES.indexOf(file.type) < 0) return Promise.reject({ code: "image_rejected", message: "Type d'image non pris en charge." });
    if (typeof createImageBitmap !== "function" || file.type === "image/gif") return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var max = 1800, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (sc >= 1 && file.size < 1500000) return file;
      var c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (resolve) { c.toBlob(function (b) { resolve(b || file); }, "image/jpeg", 0.85); });
    }).catch(function () { return file; });
  }
  var sample = {
    limits: function () { return Promise.resolve({ maxPromptBytes: 250000, images: { maxCount: 6, maxInputBytes: 20000000, mediaTypes: IMG_TYPES } }); },
    json: function (input, opts) {
      opts = opts || {};
      var files = opts.images ? (Array.isArray(opts.images) ? opts.images : (opts.images.length != null && !opts.images.type ? Array.prototype.slice.call(opts.images) : [opts.images])) : [];
      return Promise.all(files.map(function (f) { return shrink(f).then(function (b) { return blobToB64(b).then(function (d) { return { mime: b.type || f.type, data: d }; }); }); }))
        .then(function (images) { return api("/api/ai", { method: "POST", body: JSON.stringify({ prompt: String(input), images: images }) }); })
        .then(function (r) {
          try { return tolerantJson(r.text); }
          catch (e) { throw { code: "invalid_json", message: "Réponse illisible.", text: r.text }; }
        });
    }
  };

  /* ---------- lecture d'un lien ---------- */
  function pageReader(url) { return api("/api/page?url=" + encodeURIComponent(url)); }

  var caps = { db: db, user: user, sample: sample, pageReader: pageReader };
  window.claude = {
    use: function (name) {
      if (!Object.prototype.hasOwnProperty.call(caps, name)) return Promise.resolve(null);
      return meP.then(function () { return caps[name]; }, function () { return null; });
    }
  };
})();
