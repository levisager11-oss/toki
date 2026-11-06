/* Toki save support v1. Put this in the game's HTML <head>, before the game's own scripts.
   Inside Toki, it keeps a copy of everything the game stores in localStorage, so progress
   survives closing the app (iPhone deletes storage of games shown inside other sites) and
   follows logged-in players to other devices. Outside Toki it does nothing. */
(function () {
  var top = window.parent;
  if (top === window) return;
  var ls, MARK = "__toki_t";
  try { ls = window.localStorage; ls.getItem(MARK); } catch (e) { return; }
  var origin = (location.ancestorOrigins && location.ancestorOrigins[0]) ||
    (document.referrer ? new URL(document.referrer).origin : "*");
  var P = Storage.prototype, raw = { set: P.setItem, clear: P.clear };
  var ready = false, answered = false, timer = null;

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
  function later() { clearTimeout(timer); timer = setTimeout(flush, 400); }

  ["setItem", "removeItem", "clear"].forEach(function (name) {
    var fn = P[name];
    P[name] = function () {
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
