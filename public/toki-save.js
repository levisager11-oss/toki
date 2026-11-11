/* Toki save support v7. Put this in the game's HTML <head>, before the game's own scripts.
   Inside Toki, it keeps a copy of everything the game stores in localStorage, so progress
   survives closing the app (iPhone deletes storage of games shown inside other sites) and
   follows logged-in players to other devices. Outside Toki it does nothing.
   High scores: call toki.score(points) when a round ends (for times: milliseconds).
   Achievements: call toki.achievement("id") when the player earns one (ids as set on Toki).
   Multiplayer: call toki.room(code) when the player is in a room others can join with that
   code (toki.room(null) when they leave it), so they can invite their Toki friends.
   toki.onHost(fn): Toki calls fn when the player invites friends before a room is open; open a
   room for them in it (and call toki.room(code) as always), so they don't have to.
   toki.onName(fn): Toki calls fn with the name the player goes by (their Toki name, or one they
   chose in Toki), now if it knows it and again when it changes; use it in rooms instead of asking.
   toki.name has it too (null until Toki said). */
(function () {
  // Games hosted on Toki get this script added for them; a second copy in the game does nothing.
  if (window.__tokiSave) return;
  window.__tokiSave = 1;
  var top = window.parent;
  var inToki = top !== window;
  var origin = (location.ancestorOrigins && location.ancestorOrigins[0]) ||
    (document.referrer ? new URL(document.referrer).origin : "*");
  window.toki = window.toki || {};
  window.toki.score = function (n) {
    if (inToki && typeof n === "number" && isFinite(n)) top.postMessage({ toki: 1, type: "score", data: n }, origin);
  };
  window.toki.achievement = function (id) {
    if (inToki && (typeof id === "string" || typeof id === "number") && String(id)) top.postMessage({ toki: 1, type: "achievement", data: String(id).slice(0, 32) }, origin);
  };
  window.toki.room = function (code) {
    if (inToki) top.postMessage({ toki: 1, type: "room", data: code == null || code === "" ? null : String(code) }, origin);
  };
  var hostFn = null;
  window.toki.onHost = function (fn) {
    hostFn = typeof fn === "function" ? fn : null;
    if (inToki) top.postMessage({ toki: 1, type: "host", data: !!hostFn }, origin);
  };
  var nameFns = [];
  window.toki.name = null;
  window.toki.onName = function (fn) {
    if (typeof fn !== "function") return;
    nameFns.push(fn);
    if (inToki) top.postMessage({ toki: 1, type: "names", data: true }, origin);
    if (window.toki.name) try { fn(window.toki.name); } catch (err) { /* the game's own error */ }
  };
  if (!inToki) return;
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== top || !m || m.toki !== 1) return;
    if (m.type === "host" && hostFn) {
      try { hostFn(); } catch (err) { /* the game's own error: the player can still open a room by hand */ }
    }
    if (m.type === "name" && typeof m.data === "string") {
      var n = m.data.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
      if (!n || n === window.toki.name) return;
      window.toki.name = n;
      for (var i = 0; i < nameFns.length; i++) try { nameFns[i](n); } catch (err) { /* the game's own error */ }
    }
  });
  var ls, MARK = "__toki_t";
  try { ls = window.localStorage; ls.getItem(MARK); } catch (e) { return; }
  var P = Storage.prototype, raw = { set: P.setItem, clear: P.clear };
  var ready = false, answered = false, restoring = false, timer = null;

  function send(type, data) { top.postMessage({ toki: 1, type: type, data: data }, origin); }
  function keys() {
    var out = {};
    for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (k !== MARK) out[k] = ls.getItem(k); }
    return out;
  }
  function flush() {
    clearTimeout(timer); timer = null;
    var t = Date.now();
    raw.set.call(ls, MARK, String(t));
    send("store", { keys: keys(), t: t });
  }
  // Games often save while the app is closing: send that right away.
  function later() { if (document.hidden) return flush(); clearTimeout(timer); timer = setTimeout(flush, 400); }

  ["setItem", "removeItem", "clear"].forEach(function (name) {
    var fn = P[name];
    P[name] = function () {
      // Putting Toki's save back: the game may still save its old state before the reload.
      if (this === ls && restoring) return;
      var r = fn.apply(this, arguments);
      if (this === ls && ready) later();
      return r;
    };
  });

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (e.source !== top || !m || m.toki !== 1 || m.type !== "save" || answered) return;
    answered = true;
    var save = m.data, mine = Number(ls.getItem(MARK)) || 0;
    if (save && save.keys && save.t > mine) {
      // Toki has newer progress: put it back and restart the game once.
      raw.clear.call(ls);
      for (var k in save.keys) raw.set.call(ls, k, save.keys[k]);
      raw.set.call(ls, MARK, String(save.t));
      restoring = true;
      location.reload();
      return;
    }
    ready = true;
    var has = false;
    for (var key in keys()) { has = true; break; }
    if (has && (!save || mine > save.t)) later();
  });
  // No answer (an older Toki): after a while, keep the game working as before.
  setTimeout(function () { ready = true; }, 10000);
  window.addEventListener("pagehide", function () { if (timer) flush(); });
  document.addEventListener("visibilitychange", function () { if (document.hidden && timer) flush(); });
  send("hello");
})();
