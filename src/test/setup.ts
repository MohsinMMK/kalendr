import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";

configure({ asyncUtilTimeout: 5_000 });

// jsdom has no ResizeObserver; coss overlays and scroll areas measure with it.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has no IntersectionObserver; the onboarding demo's stage pauses with it while off screen.
if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

// jsdom never finishes Motion's animations, so cards leaving the board would stay. Jump straight to the end.
MotionGlobalConfig.skipAnimations = true;

// jsdom has no matchMedia; KLOQ watches the colour scheme and reduced-motion preferences with it.
if (typeof window !== "undefined" && !window.matchMedia) {
  const noMatch = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  window.matchMedia = noMatch as unknown as typeof window.matchMedia;
  (globalThis as unknown as { matchMedia: typeof noMatch }).matchMedia = noMatch;
}

// jsdom has no document.fonts; the coss Composer listens to it to re-measure its draft once fonts load.
if (typeof document !== "undefined" && !("fonts" in document)) {
  Object.defineProperty(document, "fonts", { value: { status: "loaded", ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} }, configurable: true });
}

// jsdom has no Web Animations API. Base UI's scroll area calls it directly, but its overlays and tabs
// check whether it exists to skip exit animations, so it is only exposed on scroll area viewports and on
// ui-sdk popups (menus), which use the native `popover` attribute and wait on it before settling.
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    get(this: Element) {
      return this.matches("[data-slot=scroll-area-viewport]") || this.closest("[popover]") ? () => [] : undefined;
    },
  });
}

// KLOQ fades its grid in with `element.animate`, which jsdom doesn't have either.
if (typeof Element !== "undefined" && !Object.hasOwn(Element.prototype, "animate")) {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel() {}, finish() {}, finished: Promise.resolve(), onfinish: null }),
  });
}

// ui-sdk's jsdom stubs, from its testing guide (@ui-sdk/core skills/ui-sdk/references/testing.md, "jsdom").
// They are assigned, not `??=`, because jsdom has some of them without the parts that matter.
// `getAnimations` is the one exception: it stays scoped above, because Base UI overlays treat a global
// one as "animations exist" and then wait for exit animations that jsdom never runs.
if (typeof document !== "undefined") {
  HTMLElement.prototype.showPopover = function () {};
  HTMLElement.prototype.hidePopover = function () {};
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.checkVisibility = () => true;
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  document.elementsFromPoint = () => [];
  document.head.append(
    Object.assign(document.createElement("style"), {
      textContent: "[popover] { display: block !important }",
    }),
  );
}
