"use client";

import { Bar, Collapse, Count, Phone, Spinner, Stage, States, Window, type Act } from "@/components/stageshow";

import "./onboarding-demo.css";

// What "your booking page is live" means, before the owner answers anything.
// Three beats on a device pair: a customer taps Book on the owner's page
// (cause), picks a time and confirms (action), and the booking lands on the
// owner's Today with the count rolling up (result). It plays once and holds on
// that last frame, which is also the poster for reduced motion.
// Real strings: the business, the service, Today, Book, the times, Confirm/Booked, New.

type Phase = "idle" | "sending" | "booked";
type S = { open: boolean; slot: boolean; phase: Phase; added: boolean };

const START: S = { open: false, slot: false, phase: "idle", added: false };
const DONE: S = { open: true, slot: true, phase: "booked", added: true };
const TIMES = ["9:30", "10:30", "11:00", "12:00"];
const PICK = "10:30";
const REST = { wide: { x: 600, y: 320 }, compact: { x: 300, y: 450 } };

const script = async (a: Act<S>) => {
  await a.wait(900);
  await a.click("book");
  a.put({ open: true });
  await a.wait(1000);
  await a.click("slot");
  a.put({ slot: true });
  await a.wait(500);
  await a.click("confirm");
  a.put({ phase: "sending" });
  await a.wait(800);
  a.put({ phase: "booked" });
  await a.wait(600);
  a.put({ added: true });
  await a.wait(2400);
};

/** Placeholder rows already on the owner's Today; the new one slots in after the first. */
const ROWS = [
  { time: "9:00", name: 76, what: 52 },
  { time: "11:00", name: 64, what: 60 },
  { time: "12:30", name: 82, what: 46 },
];

function TodayRow({ time, name, what, fresh, service }: { time: string; name: number; what: number; fresh?: boolean; service?: string }) {
  return (
    <div className="ob-row" data-fresh={fresh || undefined}>
      <span className="ob-row__time">{time}</span>
      <Bar w={22} h={22} r={11} tone={fresh ? 4 : 2} />
      <span className="ob-row__who">
        <Bar w={name} h={6} tone={fresh ? 4 : 3} />
        {service ? <span className="ob-row__service">{service}</span> : <Bar w={what} h={5} tone={2} />}
      </span>
      {fresh ? <span className="ob-new">New</span> : null}
    </div>
  );
}

export function OnboardingDemo({ businessName, serviceName }: { businessName: string; serviceName: string }) {
  return (
    // One picture to assistive tech: the rolling digits and faux controls inside would read as noise
    <div role="img" aria-label={`Someone books ${serviceName} at ${PICK} on your booking page, and it shows up on your Today.`}>
    <Stage<S>
      width={672}
      height={330}
      compact={{ below: 560, width: 358, height: 470 }}
      initial={START}
      poster={DONE}
      script={script}
      play="once"
      cursor={{ at: REST, style: "touch" }}
      className="ob-demo"
    >
      {(s, _rect, layout) => {
        const compact = layout === "compact";
        return (
          <>
            <Window
              className="ob-window"
              title={compact ? undefined : "Today"}
              sidebarWidth={compact ? undefined : 132}
              sidebar={compact ? undefined : (
                <nav className="ob-side">
                  <span className="ob-side__name">{businessName}</span>
                  {[44, 58, 50, 40, 54].map((w, i) => (
                    <span key={i} className="ob-side__item" data-active={i === 0 || undefined}>
                      <Bar w={10} h={10} r={3} tone={i === 0 ? 4 : 2} />
                      <Bar w={w} h={5} tone={i === 0 ? 4 : 2} />
                    </span>
                  ))}
                </nav>
              )}
            >
              <div className="ob-today">
                <div className="ob-today__head">
                  {compact ? <span className="ob-today__title">Today</span> : <Bar w={72} h={6} tone={2} />}
                  <span className="ob-count"><Count value={s.added ? 4 : 3} /> booked</span>
                </div>
                <TodayRow {...ROWS[0]} />
                <Collapse open={s.added}>
                  <TodayRow time={PICK} name={70} what={0} fresh service={serviceName} />
                </Collapse>
                <TodayRow {...ROWS[1]} />
                <TodayRow {...ROWS[2]} />
              </div>
            </Window>

            <Phone width={compact ? 196 : 216} className="ob-phone">
              <div className="ob-page">
                <div className="ob-page__brand">
                  <Bar w={40} h={40} r={12} tone={3} />
                  <span className="ob-page__name">{businessName}</span>
                </div>
                <div className="ob-service">
                  <span className="ob-service__name">{serviceName}</span>
                  <Bar w={96} h={9} r={4} tone={2} />
                  <Collapse open={!s.open}>
                    <span className="ob-btn" data-target="book">Book</span>
                  </Collapse>
                  <Collapse open={s.open}>
                    <div className="ob-times__grid">
                      {TIMES.map((time) => (
                        <span
                          key={time}
                          className="ob-chip"
                          data-on={(s.slot && time === PICK) || undefined}
                          data-target={time === PICK ? "slot" : undefined}
                        >
                          {time}
                        </span>
                      ))}
                    </div>
                    <span className="ob-btn ob-btn--wide" data-target="confirm" data-phase={s.phase} data-ready={s.slot || undefined}>
                      <States
                        value={s.phase}
                        states={{
                          idle: "Confirm",
                          sending: <Spinner size={20} />,
                          booked: "Booked",
                        }}
                      />
                    </span>
                  </Collapse>
                </div>
                <div className="ob-page__more">
                  <Bar w="80%" h={10} r={5} tone={2} />
                  <Bar w="56%" h={10} r={5} tone={2} />
                </div>
              </div>
            </Phone>
          </>
        );
      }}
    </Stage>
    </div>
  );
}
