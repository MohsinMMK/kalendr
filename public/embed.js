/*!
 * Kalendr booking embed (feature 52). One script for three ways to show booking on a website: inline, a popup behind a
 * button, and a floating button. Booking details stay inside Kalendr: the page learns only ids and times, through
 * Kalendr.on("booked", fn) or a "kalendr:booked" event on window. See docs/developers/embed.md.
 */
(function kalendrEmbed() {
  "use strict";

  var VERSION = 1;
  var PREFIX = "kalendr:";
  var EVENTS = ["opened", "service_selected", "slot_selected", "booked", "rescheduled", "cancelled", "failed"];
  var DATA_KEYS = ["serviceId", "practitionerId", "appointmentId", "startsAt", "endsAt", "status", "reason"];
  var FORWARDED = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "name", "email", "phone", "notes", "location", "person", "date", "time"];
  var script = document.currentScript;
  var scriptOrigin = script && script.src ? new URL(script.src, document.baseURI).origin : null;
  var listeners = {};
  var instances = [];

  function nonce() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function on(name, handler) {
    if (typeof handler !== "function" || EVENTS.indexOf(name) === -1) return function noop() {};
    (listeners[name] = listeners[name] || []).push(handler);
    return function off() { listeners[name] = (listeners[name] || []).filter(function (h) { return h !== handler; }); };
  }

  function emit(name, data, instance) {
    var clean = {};
    DATA_KEYS.forEach(function (key) {
      if (typeof data[key] === "string" && data[key].length <= 160) clean[key] = data[key];
    });
    (listeners[name] || []).slice().forEach(function (handler) {
      try { handler(clean, instance); } catch (error) { if (window.console) console.error(error); }
    });
    window.dispatchEvent(new CustomEvent("kalendr:" + name, { detail: clean }));
  }

  function safeUrl(value) {
    try {
      var url = new URL(value, window.location.href);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
      return url;
    } catch { return null; }
  }

  function bookingUrl(options, id) {
    if (!scriptOrigin) throw new Error("Kalendr embed needs to be loaded from its script address.");
    var business = options.business || options.clinic || "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(business)) throw new Error("Kalendr embed needs a valid business name.");
    if (options.service && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.service)) throw new Error("Kalendr embed needs a valid service name.");
    var url = new URL("/book/" + encodeURIComponent(business) + (options.service ? "/" + encodeURIComponent(options.service) : ""), scriptOrigin);
    var p = url.searchParams;
    p.set("embed", "1");
    p.set("kalendrNonce", id);
    p.set("kalendrParentOrigin", window.location.origin);
    if (["light", "dark", "auto"].indexOf(options.theme) !== -1) p.set("theme", options.theme);
    var brand = String(options.brand || "").replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(brand)) p.set("brand", brand);
    // The visitor's campaign tags and any booking-form prefill on the website's own address carry through, so tracking survives.
    var host = new URLSearchParams(window.location.search);
    FORWARDED.forEach(function (key) {
      var value = host.get(key);
      if (value) p.set(key, value.slice(0, 200));
    });
    var prefill = options.prefill || {};
    Object.keys(prefill).forEach(function (key) {
      if (FORWARDED.indexOf(key) !== -1 && typeof prefill[key] === "string") p.set(key, prefill[key].slice(0, 200));
    });
    return url;
  }

  function style(element, rules) { Object.assign(element.style, rules); }

  function create(options) {
    var id = nonce();
    var url = bookingUrl(options, id);
    var mode = options.mode === "popup" || options.mode === "floating" ? options.mode : "inline";
    var target = typeof options.mount === "string" ? document.querySelector(options.mount) : options.mount;
    if (mode !== "floating" && !target) throw new Error("Kalendr embed could not find the element to put booking in.");

    var frame = document.createElement("iframe");
    frame.title = options.title || "Appointment booking";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.loading = mode === "inline" ? "lazy" : "eager";
    if (url.origin !== window.location.origin) frame.setAttribute("sandbox", "allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    style(frame, { width: "100%", height: "100%", border: "0", background: "transparent", colorScheme: "normal" });

    var instance = { version: VERSION, open: open, close: close, destroy: destroy };
    var parts = [];
    var overlay, panel, closeButton, opener;
    var isOpen = false, previousOverflow = "", loaded = false;

    function loadFrame() { if (!loaded) { loaded = true; frame.src = url.href; } }

    function sayHello() {
      // The empty frame that exists before the address is set has the website's own origin, so wait for the real page.
      if (loaded && frame.contentWindow) frame.contentWindow.postMessage({ type: "kalendr:host-ready", version: VERSION, nonce: id }, scriptOrigin);
    }

    function onMessage(event) {
      var data = event.data;
      if (event.origin !== scriptOrigin || event.source !== frame.contentWindow || !data || typeof data !== "object" ||
          data.version !== VERSION || data.nonce !== id || typeof data.type !== "string" || data.type.indexOf(PREFIX) !== 0) return;
      if (data.type === "kalendr:bridge-ready") sayHello();
      else if (data.type === "kalendr:close") close();
      else if (data.type === "kalendr:resize" && isFinite(data.height)) {
        if (mode === "inline") frame.style.height = Math.max(480, Math.min(2400, data.height)) + "px";
      } else if (data.type === "kalendr:event" && EVENTS.indexOf(data.event) !== -1 && data.data && typeof data.data === "object") {
        emit(data.event, data.data, instance);
      } else if (data.type === "kalendr:redirect" && typeof data.url === "string") {
        var next = safeUrl(data.url);
        if (next) window.location.assign(next.href);
      }
    }
    window.addEventListener("message", onMessage);
    frame.addEventListener("load", sayHello);

    if (mode === "inline") {
      style(frame, { height: "640px", minHeight: "480px" });
      loadFrame();
      target.appendChild(frame);
      parts.push(frame);
    } else {
      var dialogId = "kalendr-dialog-" + id;
      opener = document.createElement("button");
      opener.type = "button";
      opener.textContent = options.label || "Book an appointment";
      opener.setAttribute("aria-haspopup", "dialog");
      opener.setAttribute("aria-controls", dialogId);
      opener.setAttribute("aria-expanded", "false");
      var brandColor = /^#?[0-9a-fA-F]{6}$/.test(options.brand || "") ? "#" + String(options.brand).replace(/^#/, "") : "#262626";
      style(opener, {
        appearance: "none", border: "0", borderRadius: "8px", background: brandColor, color: readable(brandColor), cursor: "pointer",
        font: "600 16px/1.25 system-ui, sans-serif", minHeight: "44px", padding: "11px 18px",
      });
      if (mode === "floating") {
        style(opener, {
          position: "fixed", bottom: "20px", zIndex: "2147482999", borderRadius: "999px", padding: "12px 22px",
          boxShadow: "0 8px 24px rgba(15,23,42,.28)",
        });
        opener.style[options.position === "left" ? "left" : "right"] = "20px";
        document.body.appendChild(opener);
      } else {
        target.appendChild(opener);
      }
      parts.push(opener);

      overlay = document.createElement("div");
      overlay.id = dialogId;
      overlay.hidden = true;
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", options.title || "Book an appointment");
      style(overlay, { position: "fixed", inset: "0", zIndex: "2147483000", background: "rgba(15,23,42,.58)", padding: "max(12px, 3vw)" });
      panel = document.createElement("div");
      style(panel, {
        position: "relative", width: "min(100%, 760px)", height: "min(92vh, 900px)", margin: "auto", borderRadius: "12px",
        background: "#ffffff", boxShadow: "0 24px 70px rgba(15,23,42,.28)", overflow: "hidden",
      });
      closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.textContent = "Close";
      closeButton.setAttribute("aria-label", "Close booking");
      style(closeButton, {
        position: "absolute", top: "8px", right: "8px", zIndex: "2", minHeight: "40px", border: "1px solid #cbd5e1", borderRadius: "6px",
        background: "#ffffff", color: "#0f172a", cursor: "pointer", font: "600 14px/1 system-ui, sans-serif", padding: "8px 12px",
      });
      panel.appendChild(closeButton);
      panel.appendChild(frame);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      parts.push(overlay);

      opener.addEventListener("click", open);
      closeButton.addEventListener("click", close);
      overlay.addEventListener("click", function (event) { if (event.target === overlay) close(); });
      overlay.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { close(); return; }
        if (event.key !== "Tab") return;
        var first = closeButton, last = frame;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
      document.addEventListener("focusin", keepFocus);
      // The frame starts loading on the first hover or focus, so the popup opens already filled.
      opener.addEventListener("pointerenter", loadFrame, { once: true });
      opener.addEventListener("focus", loadFrame, { once: true });
    }

    function keepFocus(event) { if (isOpen && !overlay.contains(event.target)) closeButton.focus(); }

    function open() {
      if (mode === "inline" || isOpen) return;
      loadFrame();
      previousOverflow = document.documentElement.style.overflow;
      overlay.hidden = false;
      document.documentElement.style.overflow = "hidden";
      opener.setAttribute("aria-expanded", "true");
      isOpen = true;
      closeButton.focus();
    }

    function close() {
      if (mode === "inline" || !isOpen) return;
      overlay.hidden = true;
      document.documentElement.style.overflow = previousOverflow;
      opener.setAttribute("aria-expanded", "false");
      isOpen = false;
      opener.focus();
    }

    function destroy() {
      if (isOpen) { document.documentElement.style.overflow = previousOverflow; isOpen = false; }
      window.removeEventListener("message", onMessage);
      document.removeEventListener("focusin", keepFocus);
      parts.forEach(function (part) { if (part.parentNode) part.parentNode.removeChild(part); });
      instances = instances.filter(function (entry) { return entry !== instance; });
    }

    instances.push(instance);
    return Object.freeze(instance);
  }

  /** Black or white, whichever reads better on the button colour. */
  function readable(hex) {
    var value = hex.replace("#", "");
    var channels = [0, 2, 4].map(function (i) {
      var c = parseInt(value.substr(i, 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.4 ? "#111111" : "#ffffff";
  }

  window.Kalendr = Object.freeze({ version: VERSION, embed: create, on: on });

  if (script && script.dataset.kalendrBusiness) {
    var data = script.dataset;
    var start = function () {
      create({
        business: data.kalendrBusiness, service: data.kalendrService, mode: data.kalendrMode, mount: data.kalendrMount,
        theme: data.kalendrTheme, brand: data.kalendrBrand, label: data.kalendrLabel, title: data.kalendrTitle, position: data.kalendrPosition,
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})();
