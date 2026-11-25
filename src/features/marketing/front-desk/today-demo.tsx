"use client";

import { Bell, Footprints, UserPlus, X } from "lucide-react";

import { Avatar, Badge, Bar, Button, Collapse, Count, Field, Popover, Stage, Tabs, Window, type Act } from "@/components/stageshow";

import "./today-demo.css";

// Northside Studio's Today board on Monday 12 October. Three beats, each with
// a cause: a booking request is approved from the bell, the customer arrives
// and is checked in, and a walk-in is added at the desk. The story plays once
// and holds on the full Waiting column, which is also the poster.
// Real strings (from src/features/clinic): the column names Up next, Waiting,
// With stylist, Done; the overview tiles; "Needs approval" shown as the
// Request badge on a card; the bell's Notifications drawer with its Alerts and
// Needs attention tabs; Booking request, Approve, Decline; the status step
// Check in; "Add walk-in"; and the Walk-in badge with a # token.

type Panel = "none" | "bell" | "walkin";
type S = {
  panel: Panel;
  /** The request was approved from the bell. */
  approved: boolean;
  /** Neel's status menu is open under her card. */
  menu: boolean;
  /** Neel was checked in and moved to Waiting. */
  checkedIn: boolean;
  /** Name typed into the walk-in drawer. */
  name: string;
  /** The walk-in was added to Waiting. */
  walkIn: boolean;
};

const START: S = { panel: "none", approved: false, menu: false, checkedIn: false, name: "", walkIn: false };
const DONE: S = { panel: "none", approved: true, menu: false, checkedIn: true, name: "", walkIn: true };

const script = async (a: Act<S>) => {
  await a.wait(1200);
  await a.click("bell");
  a.put({ panel: "bell" });
  await a.wait(1200);
  await a.click({ at: "approve", x: 0.85, y: 0.6 });
  a.put({ approved: true });
  await a.wait(1100);
  await a.click("close");
  a.put({ panel: "none" });
  await a.wait(700);
  await a.click("neel");
  a.put({ menu: true });
  await a.wait(700);
  await a.click({ at: "checkin", x: 0.8, y: 0.6 });
  a.put({ menu: false });
  await a.wait(150);
  a.put({ checkedIn: true });
  await a.wait(1400);
  await a.click("walkin");
  a.put({ panel: "walkin" });
  await a.wait(700);
  await a.click({ at: "name", x: 0.9, y: 0.6 });
  await a.type("name", "Ishaan Gupta", { interval: 70 });
  await a.wait(500);
  await a.click({ at: "add", x: 0.85, y: 0.6 });
  a.put({ panel: "none" });
  await a.wait(250);
  a.put({ walkIn: true });
  await a.wait(900);
  await a.move(REST[a.layout]);
  await a.wait(1800);
};

const REST = { wide: { x: 560, y: 330 }, compact: { x: 290, y: 380 } };

type CardProps = {
  token?: string;
  time?: string;
  name: string;
  service: string;
  person: string;
  flag?: "request" | "walk-in";
  target?: string;
  quiet?: boolean;
};

function Card({ token, time, name, service, person, flag, target, quiet }: CardProps) {
  return (
    <div className="fd-card" data-target={target} data-quiet={quiet || undefined}>
      <div className="fd-card__top">
        <span className="fd-card__ticket">{token ? token : time}</span>
        {token && time ? <span className="fd-card__time">· {time}</span> : null}
        <Avatar name={person} size={18} className="fd-card__who" />
      </div>
      <span className="fd-card__name">{name}</span>
      <div className="fd-card__chips">
        <span className="fd-chip">{service}</span>
        {flag === "request" ? <Badge tone="warning">Request</Badge> : null}
        {flag === "walk-in" ? (
          <Badge tone="neutral" icon={<Footprints size={11} strokeWidth={1.75} aria-hidden="true" />}>Walk-in</Badge>
        ) : null}
      </div>
    </div>
  );
}

function Slot({ children }: { children: React.ReactNode }) {
  return <div className="fd-slot">{children}</div>;
}

function ColumnHead({ title, count, tool }: { title: string; count: number; tool?: React.ReactNode }) {
  return (
    <div className="fd-head">
      <span className="fd-head__title">{title}</span>
      <span className="fd-head__count"><Count value={count} /></span>
      {tool}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="fd-tile">
      <span className="fd-tile__label">{label}</span>
      <span className="fd-tile__value"><Count value={value} /></span>
      {hint ? <span className="fd-tile__hint">{hint}</span> : null}
    </div>
  );
}

export function TodayDemo() {
  return (
    <div className="mk-demo fd-demo">
      <figure
        className="m-0"
        aria-label="Northside Studio's Today board. A booking request is approved from the bell and becomes a booking, the customer arrives and is checked in to the Waiting column, and a walk-in is added to Waiting."
      >
        <div aria-hidden="true">
          <Stage<S>
            width={672}
            height={376}
            compact={{ below: 560, width: 358, height: 316 }}
            initial={START}
            poster={DONE}
            script={script}
            play="once"
            cursor={{ at: REST, style: "arrow" }}
          >
            {(s, _rect, layout) => {
              const compact = layout === "compact";
              const arriving = (s.checkedIn ? 1 : 2);
              const waiting = (s.checkedIn ? 1 : 0) + (s.walkIn ? 1 : 0);
              return (
                <Window
                  className="fd-window"
                  title="Today"
                  toolbar={
                    <span className="fd-bell" data-target="bell" aria-hidden="true">
                      <Bell size={15} strokeWidth={1.5} />
                      <span className="fd-bell__badge" data-on={!s.approved || undefined}>1</span>
                    </span>
                  }
                >
                  <div className="fd-body">
                    {compact ? null : <div className="fd-tiles">
                      <Tile label="Still to arrive" value={arriving} hint="Next 11:30" />
                      <Tile label="Waiting" value={waiting} />
                      <Tile label="With stylist" value={1} />
                      <Tile label="Done" value={1} />
                    </div>}

                    <div className="fd-board">
                      <section className="fd-col">
                        <ColumnHead title="Up next" count={arriving} />
                        <Collapse open={!s.checkedIn}>
                          <div className="fd-menuwrap fd-slot">
                            <Card time="11:00" name="Neel Kapoor" service="Haircut" person="Anika Iyer" flag={s.approved ? undefined : "request"} target="neel" />
                            <Popover show={s.menu} origin="top left" className="fd-menu">
                              <div className="fd-menu__item" data-target="checkin">Check in</div>
                              <div className="fd-menu__item" data-muted>Cancel visit…</div>
                            </Popover>
                          </div>
                        </Collapse>
                        <Slot><Card time="11:30" name="Priya Menon" service="Blow-dry" person="Rohan Das" /></Slot>
                      </section>

                      <section className="fd-col">
                        <ColumnHead
                          title="Waiting"
                          count={waiting}
                          tool={<span className="fd-tool" data-target="walkin" aria-hidden="true"><UserPlus size={14} strokeWidth={1.5} /></span>}
                        />
                        <Collapse open={s.checkedIn}>
                          <Slot><Card token="#1" time="11:02" name="Neel Kapoor" service="Haircut" person="Anika Iyer" /></Slot>
                        </Collapse>
                        <Collapse open={s.walkIn}>
                          <Slot><Card token="#2" time="11:08" name="Ishaan Gupta" service="Beard trim" person="Rohan Das" flag="walk-in" /></Slot>
                        </Collapse>
                      </section>

                      {compact ? null : (
                        <section className="fd-col">
                          <ColumnHead title="With stylist" count={1} />
                          <Slot><Card token="#9" time="10:30" name="Kabir Sen" service="Hair colour" person="Meera Nair" /></Slot>
                        </section>
                      )}
                      {compact ? null : (
                        <section className="fd-col">
                          <ColumnHead title="Done" count={1} />
                          <Slot><Card time="10:00" name="Neel Kapoor" service="Haircut" person="Anika Iyer" quiet /></Slot>
                        </section>
                      )}
                    </div>

                    <aside className="fd-panel" data-open={s.panel !== "none" || undefined} data-panel={s.panel}>
                      <div className="fd-panel__bar">
                        <span className="fd-panel__title">{s.panel === "walkin" ? "Add walk-in" : "Notifications"}</span>
                        <span className="fd-panel__close" data-target="close" aria-hidden="true"><X size={14} strokeWidth={1.5} /></span>
                      </div>
                      <div className="fd-panel__bell" data-show={s.panel === "bell" || undefined}>
                        <Tabs items={["Alerts", "Needs attention"]} value={1} />
                        <Collapse open={!s.approved}>
                          <div className="fd-request">
                            <span className="fd-request__title">Booking request</span>
                            <span className="fd-request__detail">Neel Kapoor · 11:00</span>
                            <div className="fd-request__actions">
                              <Button variant="primary" size="small" data-target="approve">Approve</Button>
                              <Button size="small">Decline</Button>
                            </div>
                          </div>
                        </Collapse>
                        <Bar w="70%" h={6} tone={2} />
                        <Bar w="48%" h={5} tone={2} />
                      </div>
                      <div className="fd-panel__walkin" data-show={s.panel === "walkin" || undefined}>
                        <Field label="Client" value={s.name} placeholder="Name or phone" focused={s.panel === "walkin" && !s.walkIn} box={{ "data-target": "name" }} />
                        <div className="fd-service">
                          <span className="fd-service__label">Service</span>
                          <span className="fd-service__value">Beard trim <span className="fd-service__len">30 min</span></span>
                        </div>
                        <Button variant="primary" data-target="add">Check in</Button>
                      </div>
                    </aside>
                  </div>
                </Window>
              );
            }}
          </Stage>
        </div>
      </figure>
    </div>
  );
}
