/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shortcutFor, useHotkeys } from "./hotkeys";

afterEach(cleanup);

function press(key: string, init: Partial<KeyboardEventInit> = {}, target: EventTarget | null = document.body) {
  return shortcutFor({ key, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, repeat: false, defaultPrevented: false, target, ...init });
}

describe("which key means which shortcut", () => {
  it("maps the daily keys", () => {
    expect(press("n")).toBe("new");
    expect(press("N")).toBe("new");
    expect(press("t")).toBe("today");
    expect(press("ArrowLeft")).toBe("previous");
    expect(press("ArrowRight")).toBe("next");
    expect(press("/")).toBe("search");
    expect(press("?")).toBe("help");
  });

  it("ignores keys that mean something else", () => {
    expect(press("x")).toBeNull();
    expect(press("Enter")).toBeNull();
    expect(press("n", { ctrlKey: true })).toBeNull();
    expect(press("t", { metaKey: true })).toBeNull();
    expect(press("ArrowLeft", { altKey: true })).toBeNull();
  });

  it("does not repeat a one-off action when the key is held down", () => {
    expect(press("n", { repeat: true })).toBeNull();
    expect(press("ArrowRight", { repeat: true })).toBe("next");
  });

  it("leaves a key alone while an input method is composing text", () => {
    expect(press("n", { isComposing: true })).toBeNull();
  });
});

describe("typing never triggers a shortcut", () => {
  it.each([
    ["a text box", () => document.createElement("input")],
    ["a text area", () => document.createElement("textarea")],
    ["a drop-down", () => document.createElement("select")],
    ["an editable block", () => { const div = document.createElement("div"); div.setAttribute("contenteditable", "true"); Object.defineProperty(div, "isContentEditable", { value: true }); return div; }],
    ["a search box role", () => { const div = document.createElement("div"); div.setAttribute("role", "combobox"); return div; }],
  ])("in %s", (_name, make) => {
    const element = make();
    expect(press("n", {}, element)).toBeNull();
    expect(press("/", {}, element)).toBeNull();
    expect(press("ArrowLeft", {}, element)).toBeNull();
  });
});

function Harness({ handlers }: { handlers: Parameters<typeof useHotkeys>[0] }) {
  useHotkeys(handlers, { ignoreInside: "[data-calendar]" });
  return <div><input aria-label="Name" /><div data-calendar><button>Slot</button></div><button>Plain</button></div>;
}

describe("the shortcuts on a page", () => {
  it("run the action for the key", async () => {
    const user = userEvent.setup();
    const handlers = { new: vi.fn(), today: vi.fn(), next: vi.fn() };
    render(<Harness handlers={handlers} />);
    await user.keyboard("n");
    await user.keyboard("t");
    await user.keyboard("{ArrowRight}");
    expect(handlers.new).toHaveBeenCalledTimes(1);
    expect(handlers.today).toHaveBeenCalledTimes(1);
    expect(handlers.next).toHaveBeenCalledTimes(1);
  });

  it("stay quiet while typing in a field", async () => {
    const user = userEvent.setup();
    const handlers = { new: vi.fn(), search: vi.fn() };
    const view = render(<Harness handlers={handlers} />);
    await user.click(view.getByRole("textbox", { name: "Name" }));
    await user.keyboard("nancy/");
    expect(handlers.new).not.toHaveBeenCalled();
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it("stay quiet while a dialog is open", async () => {
    const user = userEvent.setup();
    const handlers = { new: vi.fn() };
    render(<><Harness handlers={handlers} /><div role="dialog">Settings</div></>);
    await user.keyboard("n");
    expect(handlers.new).not.toHaveBeenCalled();
  });

  it("ignore a dialog that closed and is only kept hidden in the page", async () => {
    const user = userEvent.setup();
    const handlers = { new: vi.fn() };
    render(<><Harness handlers={handlers} /><div role="dialog" hidden data-closed="">Settings</div></>);
    await user.keyboard("n");
    expect(handlers.new).toHaveBeenCalledTimes(1);
  });

  it("leave the keys inside the calendar to the calendar", async () => {
    const user = userEvent.setup();
    const handlers = { next: vi.fn() };
    const view = render(<Harness handlers={handlers} />);
    view.getByRole("button", { name: "Slot" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(handlers.next).not.toHaveBeenCalled();
    view.getByRole("button", { name: "Plain" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(handlers.next).toHaveBeenCalledTimes(1);
  });
});
