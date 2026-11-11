/* Toki save support v9. Put this in the game's HTML <head>, before the game's own scripts.
   Inside Toki, it keeps a copy of everything the game stores in localStorage, so progress
   survives closing the app (iPhone deletes storage of games shown inside other sites) and
   follows logged-in players to other devices. Outside Toki it does nothing.
   High scores: call toki.score(points) when a round ends (for times: milliseconds).
   toki.score(points, "id") sends it to another of the game's lists instead (ids as set on Toki).
   Achievements: call toki.achievement("id") when the player earns one (ids as set on Toki).
   Multiplayer: call toki.room(code) when the player is in a room others can join with that
   code (toki.room(null) when they leave it), so they can invite their Toki friends.
   toki.onHost(fn): Toki calls fn when the player invites friends before a room is open; open a
   room for them in it (and call toki.room(code) as always), so they don't have to.
   toki.onName(fn): Toki calls fn with the name the player goes by (their Toki name, or one they
   chose in Toki), now if it knows it and again when it changes; use it in rooms instead of asking.
   toki.name has it too (null until Toki said).
   On phones inside Toki, swipes and quick taps in the game don't scroll or zoom the Toki page
   around it (only where the game itself has nothing to scroll). */
(function () {
  // Games hosted on Toki get this script added for them; a second copy in the game does nothing.
  if (window.__tokiSave) return;
  window.__tokiSave = 1;
  var top = window.parent;
  var inToki = top !== window;
  var origin = (location.ancestorOrigins && location.ancestorOrigins[0]) ||
    (document.referrer ? new URL(document.referrer).origin : "*");
  window.toki = window.toki || {};
  window.toki.score = function (n, board) {
    if (!inToki || typeof n !== "number" || !isFinite(n)) return;
    var m = { toki: 1, type: "score", data: n };
    if ((typeof board === "string" || typeof board === "number") && String(board)) m.board = String(board).slice(0, 32);
    top.postMessage(m, origin);
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
  // Phones (iPhone above all) pass a swipe or a fast double tap in a game up to the Toki page,
  // which then scrolls or zooms away from the game mid-play. Stop that, except where the game
  // itself has something to scroll. Games keep their own touch-action: this one has no weight.
  if ("ontouchstart" in window) {
    var css = document.createElement("style");
    css.textContent = ":where(html){touch-action:manipulation}";
    (document.head || document.documentElement).appendChild(css);
    var scrolls = function (el) {
      for (; el && el.nodeType === 1; el = el.parentNode) {
        var st = getComputedStyle(el);
        if ((/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) ||
            (/(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1)) return true;
      }
      var root = document.scrollingElement || document.documentElement;
      var shut = function (n) { return n && /hidden|clip/.test(getComputedStyle(n).overflow); };
      if (shut(document.documentElement) || shut(document.body)) return false;
      return root.scrollHeight > window.innerHeight + 1 || root.scrollWidth > window.innerWidth + 1;
    };
    var free = true;
    document.addEventListener("touchstart", function (e) {
      free = e.touches.length < 2 && scrolls(e.target);
    }, { passive: true, capture: true });
    document.addEventListener("touchmove", function (e) {
      if ((!free || e.touches.length > 1) && e.cancelable) e.preventDefault();
    }, { passive: false, capture: true });
    document.addEventListener("gesturestart", function (e) { e.preventDefault(); }, { passive: false });
  }
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
