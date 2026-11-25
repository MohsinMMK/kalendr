"use client";

import { Avatar, Badge, Bar, Collapse, Count, Phone, Spinner, Stage, States, Window, type Act } from "@/components/stageshow";

import "./hero-demo.css";

// One booking, told on a device pair. A customer on a phone opens Northside
// Studio's booking page, picks Haircut and a time (cause), taps Confirm
// (action), and the booking lands on the owner's Today with the count rolling
// from 3 to 4 (result). It plays once and holds on that last frame, which is
// also the poster for reduced motion and the first paint.

type Step = "services" | "times";
type Phase = "idle" | "sending" | "booked";
type S = { step: Step; slot: boolean; phase: Phase; added: boolean };

const START: S = { step: "services", slot: false, phase: "idle", added: false };
const DONE: S = { step: "times", slot: true, phase: "booked", added: true };

const SERVICES = [
  ["Haircut", "45 min"],
  ["Blow-dry", "30 min"],
  ["Hair colour", "90 min"],
  ["Beard trim", "30 min"],
] as const;
const TIMES = ["9:30", "10:30", "11:00", "12:00"];
const PICK = "10:30";
const REST = { wide: { x: 560, y: 340 }, compact: { x: 300, y: 450 } };

const script = async (a: Act<S>) => {
  await a.wait(1000);
  await a.click("service");
  a.put({ step: "times" });
  await a.wait(1000);
  await a.click("slot");
  a.put({ slot: true });
  await a.wait(500);
  await a.click("confirm");
  a.put({ phase: "sending" });
  await a.wait(800);
  a.put({ phase: "booked" });
  await a.wait(700);
  a.put({ added: true });
  await a.wait(2600);
};

const NAV = ["Today", "Schedule", "Bookings", "Clients"];

const EARLIER = { time: "9:00", name: "Arjun Rao", service: "Hair colour" };
const LATER = [
  { time: "11:00", name: "Kabir Sen", service: "Beard trim" },
  { time: "12:30", name: "Priya Menon", service: "Blow-dry" },
  { time: "2:00", name: "Neel Kapoor", service: "Haircut" },
  { time: "3:30", name: "Riya Shah", service: "Blow-dry" },
];

function Visit({ time, name, service, fresh }: { time: string; name: string; service: string; fresh?: boolean }) {
  return (
    <div className="hm-row" data-fresh={fresh || undefined}>
      <span className="hm-row__time">{time}</span>
      <Avatar name={name} size={24} />
      <span className="hm-row__who">
        <span className="hm-row__name">{name}</span>
        <span className="hm-row__service">{service}</span>
      </span>
      {fresh ? <span className="hm-new">New</span> : <Badge>Booked</Badge>}
    </div>
  );
}

export function HeroDemo() {
  return (
    <div className="mk-demo hm-demo">
      <figure
        className="m-0"
        aria-label="A customer books a haircut at 10:30 on Northside Studio's booking page, and the booking appears on the owner's Today."
      >
        <div aria-hidden="true">
          <Stage<S>
            width={680}
            height={400}
            compact={{ below: 560, width: 358, height: 340 }}
            initial={START}
            poster={DONE}
            script={script}
            play="once"
            cursor={{ at: REST, style: "touch" }}
          >
            {(s, _rect, layout) => {
              const compact = layout === "compact";
              return (
                <>
                                      <Window
                      className="hm-window"
                      title={compact ? undefined : "Northside Studio"}
                      sidebarWidth={compact ? undefined : 124}
                      sidebar={compact ? undefined : (
                        <nav className="hm-side">
                          {NAV.map((label, i) => (
                            <span key={label} className="hm-side__item" data-active={i === 0 || undefined}>
                              <Bar w={10} h={10} r={3} tone={i === 0 ? 4 : 2} />
                              {label}
                            </span>
                          ))}
                        </nav>
                      )}
                    >
                      <div className="hm-today">
                        <div className="hm-today__head">
                          <span className="hm-today__title">Today</span>
                          <span className="hm-count"><Count value={s.added ? 4 : 3} /> booked</span>
                        </div>
                        <Visit {...EARLIER} />
                        <Collapse open={s.added}>
                          <Visit time={PICK} name="Tara Bose" service="Haircut" fresh />
                        </Collapse>
                        {LATER.map((visit) => <Visit key={visit.time} {...visit} />)}
                      </div>
                    </Window>

                  <Phone width={compact ? 180 : 216} className="hm-phone">
                    <div className="hm-page">
                      <div className="hm-page__brand">
                        <span className="hm-page__name">Northside Studio</span>
                      </div>
                      <Collapse open={s.step === "services"}>
                        <div className="hm-list">
                          {SERVICES.map(([name, length]) => (
                            <span key={name} className="hm-svc" data-target={name === "Haircut" ? "service" : undefined}>
                              <span className="hm-svc__name">{name}</span>
                              <span className="hm-svc__len">{length}</span>
                            </span>
                          ))}
                        </div>
                      </Collapse>
                      <Collapse open={s.step === "times"}>
                        <div className="hm-pick">
                          <span className="hm-pick__service">Haircut <span className="hm-svc__len">45 min</span></span>
                          <div className="hm-times">
                            {TIMES.map((time) => (
                              <span
                                key={time}
                                className="hm-chip"
                                data-on={(s.slot && time === PICK) || undefined}
                                data-target={time === PICK ? "slot" : undefined}
                              >
                                {time}
                              </span>
                            ))}
                          </div>
                          <span className="hm-btn" data-target="confirm" data-phase={s.phase} data-ready={s.slot || undefined}>
                            <States
                              value={s.phase}
                              states={{ idle: "Confirm", sending: <Spinner size={20} />, booked: "Booked" }}
                            />
                          </span>
                        </div>
                      </Collapse>
                    </div>
                  </Phone>
                </>
              );
            }}
          </Stage>
        </div>
      </figure>
    </div>
  );
}
