(function kalendrWidgetLoader() {
  "use strict";

  var VERSION = 1;
  var MESSAGE_PREFIX = "kalendr:";
  var script = document.currentScript;
  var scriptOrigin = script && script.src ? new URL(script.src, document.baseURI).origin : null;

  function createNonce() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, function toHex(byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function getBookingUrl(options) {
    if (!scriptOrigin) throw new Error("Kalendr widget requires a script URL.");
    var clinic = options.clinic || "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clinic)) {
      throw new Error("Kalendr widget requires a valid clinic slug.");
    }
    var requestedUrl = options.url || "/book/" + encodeURIComponent(clinic);
    var bookingUrl = new URL(requestedUrl, scriptOrigin);
    if (bookingUrl.origin !== scriptOrigin) {
      throw new Error("Kalendr booking URL must use the widget script origin.");
    }
    return bookingUrl;
  }

  function mount(options) {
    var target =
      typeof options.mount === "string"
        ? document.querySelector(options.mount)
        : options.mount;
    if (!target) throw new Error("Kalendr widget mount element was not found.");

    var bookingUrl = getBookingUrl(options);
    var nonce = createNonce();
    bookingUrl.searchParams.set("embed", "1");
    bookingUrl.searchParams.set("kalendrNonce", nonce);
    bookingUrl.searchParams.set("kalendrParentOrigin", window.location.origin);
    // Carry the host page's campaign tags so the clinic can see which ad or post brought the patient.
    var parentQuery = new URLSearchParams(window.location.search);
    ["utm_source", "utm_medium", "utm_campaign"].forEach(function (name) {
      var value = parentQuery.get(name);
      if (value && !bookingUrl.searchParams.has(name)) bookingUrl.searchParams.set(name, value.slice(0, 100));
    });

    var opener = document.createElement("button");
    var dialogId = "kalendr-booking-dialog-" + nonce;
    opener.type = "button";
    opener.textContent = options.label || "Book an appointment";
    opener.setAttribute("aria-haspopup", "dialog");
    opener.setAttribute("aria-controls", dialogId);
    opener.setAttribute("aria-expanded", "false");
    Object.assign(opener.style, {
      appearance: "none",
      border: "0",
      borderRadius: "6px",
      background: "#262626",
      color: "#ffffff",
      cursor: "pointer",
      font: "600 16px/1.25 system-ui, sans-serif",
      minHeight: "44px",
      padding: "11px 18px",
    });

    var overlay = document.createElement("div");
    overlay.id = dialogId;
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Book an appointment");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483000",
      background: "rgba(15, 23, 42, 0.58)",
      padding: "max(12px, 3vw)",
    });

    var panel = document.createElement("div");
    Object.assign(panel.style, {
      position: "relative",
      width: "min(100%, 760px)",
      height: "min(92vh, 900px)",
      margin: "auto",
      borderRadius: "10px",
      background: "#ffffff",
      boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
      overflow: "hidden",
    });

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close";
    closeButton.setAttribute("aria-label", "Close appointment booking");
    Object.assign(closeButton.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      zIndex: "2",
      minHeight: "40px",
      border: "1px solid #cbd5e1",
      borderRadius: "6px",
      background: "#ffffff",
      color: "#0f172a",
      cursor: "pointer",
      font: "600 14px/1 system-ui, sans-serif",
      padding: "8px 12px",
    });

    var frame = document.createElement("iframe");
    frame.src = bookingUrl.href;
    frame.title = options.title || "Appointment booking";
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    // Cross-origin clinic sites get an explicit capability sandbox. A same-origin
    // preview cannot gain isolation from allow-scripts + allow-same-origin, so
    // omitting the ineffective sandbox also avoids a misleading browser warning.
    if (bookingUrl.origin !== window.location.origin) {
      frame.setAttribute(
        "sandbox",
        "allow-forms allow-scripts allow-same-origin allow-popups",
      );
    }
    Object.assign(frame.style, {
      width: "100%",
      height: "100%",
      border: "0",
      background: "#ffffff",
    });

    var previousOverflow = "";
    var isOpen = false;

    function close() {
      if (!isOpen) return;
      overlay.hidden = true;
      document.documentElement.style.overflow = previousOverflow;
      opener.setAttribute("aria-expanded", "false");
      isOpen = false;
      opener.focus();
    }

    function open() {
      if (isOpen) return;
      previousOverflow = document.documentElement.style.overflow;
      overlay.hidden = false;
      document.documentElement.style.overflow = "hidden";
      opener.setAttribute("aria-expanded", "true");
      isOpen = true;
      closeButton.focus();
    }

    function keepFocusInside(event) {
      if (!isOpen || overlay.contains(event.target)) return;
      closeButton.focus();
    }

    function onMessage(event) {
      if (
        event.origin !== scriptOrigin ||
        event.source !== frame.contentWindow ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.version !== VERSION ||
        event.data.nonce !== nonce ||
        typeof event.data.type !== "string" ||
        !event.data.type.startsWith(MESSAGE_PREFIX)
      ) {
        return;
      }

      if (event.data.type === "kalendr:bridge-ready") {
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage(
          { type: "kalendr:host-ready", version: VERSION, nonce: nonce },
          scriptOrigin,
        );
      } else if (event.data.type === "kalendr:close") {
        close();
      } else if (
        event.data.type === "kalendr:resize" &&
        Number.isFinite(event.data.height)
      ) {
        panel.style.height = Math.max(480, Math.min(900, event.data.height)) + "px";
      } else if (
        event.data.type === "kalendr:completed" &&
        typeof event.data.appointmentReference === "string" &&
        /^[A-Za-z0-9_-]{1,160}$/.test(event.data.appointmentReference)
      ) {
        window.dispatchEvent(
          new CustomEvent("kalendr:booking-completed", {
            detail: { appointmentReference: event.data.appointmentReference },
          }),
        );
      }
    }

    opener.addEventListener("click", open);
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", function closeOnBackdrop(event) {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", function trapFocus(event) {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") return;

      var focusable = [closeButton, frame];
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    frame.addEventListener("load", function announceHost() {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage(
        { type: "kalendr:host-ready", version: VERSION, nonce: nonce },
        scriptOrigin,
      );
    });
    window.addEventListener("message", onMessage);
    document.addEventListener("focusin", keepFocusInside);

    panel.append(closeButton, frame);
    overlay.append(panel);
    target.append(opener, overlay);

    return Object.freeze({
      version: VERSION,
      open: open,
      close: close,
      destroy: function destroy() {
        if (isOpen) {
          document.documentElement.style.overflow = previousOverflow;
          opener.setAttribute("aria-expanded", "false");
          isOpen = false;
        }
        window.removeEventListener("message", onMessage);
        document.removeEventListener("focusin", keepFocusInside);
        overlay.remove();
        opener.remove();
      },
    });
  }

  window.KalendrBookingWidget = Object.freeze({ version: VERSION, mount: mount });

  if (script && script.dataset.kalendrClinic && script.dataset.kalendrMount) {
    mount({
      clinic: script.dataset.kalendrClinic,
      mount: script.dataset.kalendrMount,
      url: script.dataset.kalendrUrl,
      label: script.dataset.kalendrLabel,
      title: script.dataset.kalendrTitle,
    });
  }
})();
