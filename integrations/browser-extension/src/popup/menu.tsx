import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A small action menu: a button that opens a list of actions. Keyboard: Enter or the arrow keys open it, the arrows move,
 * Escape closes and returns to the button. Kept here because the popup is a separate bundle that cannot share the web app's
 * components.
 */
export interface MenuAction { label: string; onSelect: () => void; destructive?: boolean }

export function ActionMenu({ label, actions, children }: { label: string; actions: MenuAction[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function move(event: React.KeyboardEvent, direction: 1 | -1) {
    event.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + direction + items.length) % items.length]?.focus();
  }

  return (
    <div className="menu">
      <button ref={button} type="button" className="icon-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); } }}>
        {children}
      </button>
      {open ? (
        <ul ref={list} id={id} role="menu" aria-label={label} className="menu-list"
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setOpen(false); button.current?.focus(); }
            if (event.key === "ArrowDown") move(event, 1);
            if (event.key === "ArrowUp") move(event, -1);
          }}>
          {actions.map((action) => (
            <li key={action.label} role="none">
              <button type="button" role="menuitem" className={action.destructive ? "menu-item destructive" : "menu-item"}
                onClick={() => { setOpen(false); action.onSelect(); }}>{action.label}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
