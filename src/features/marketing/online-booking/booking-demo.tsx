"use client";

import { ArrowLeft, ArrowRight, CalendarDays, CircleCheck, ClipboardList, UserRound } from "lucide-react";

import { Phone, Spinner, Stage, States, type Act } from "@/components/stageshow";

import "./booking-demo.css";

// A customer books on their phone. The beats follow the real booking flow
// (src/features/booking): a service tap moves straight on (cause), a time tap
// moves straight on, the business's own question is answered with a tap and
// Continue, the details are typed and Confirm booking is pressed (action), and
// the page answers "You're booked" with Manage appointment (result). It plays
// once and holds on that last screen, which is also the reduced-motion poster.
// Real strings: What would you like to book?, Request, When works for you?,
// Continue, Your details, Full name, Mobile number, Email address,
// Confirm booking, You're booked, Date and time, Manage appointment.
// The business's own words: Northside Studio, the services, the question.

type S = { step: number; service: boolean; slot: boolean; answer: "none" | "no"; name: string; sending: boolean };

const START: S = { step: 0, service: false, slot: false, answer: "none", name: "", sending: false };
const DONE: S = { step: 4, service: true, slot: true, answer: "no", name: "Riya Shah", sending: false };
const NAME = "Riya Shah";
const REST = { wide: { x: 480, y: 470 }, compact: { x: 300, y: 440 } };

const SERVICES = [
  { name: "Haircut", meta: "45 min", pick: true },
  { name: "Blow-dry", meta: "30 min" },
  { name: "Hair colour", meta: "90 min", request: true },
];
const TIMES = ["10:00", "10:45", "11:30", "12:15", "13:00", "14:30"];
const PICK_TIME = "11:30";
const DAYS = [
  ["Mon", "12"],
  ["Tue", "13"],
  ["Wed", "14"],
  ["Thu", "15"],
  ["Fri", "16"],
];

const script = async (a: Act<S>) => {
  await a.wait(1000);
  await a.click("service");
  a.put({ service: true });
  await a.wait(320);
  a.put({ step: 1 });
  await a.wait(1100);
  await a.click("time");
  a.put({ slot: true });
  await a.wait(320);
  a.put({ step: 2 });
  await a.wait(1100);
  await a.click("no");
  a.put({ answer: "no" });
  await a.wait(500);
  await a.click("continue");
  a.put({ step: 3 });
  await a.wait(1000);
  await a.type("name", NAME, { interval: 70 });
  await a.wait(400);
  await a.click("confirm");
  a.put({ sending: true });
  await a.wait(900);
  a.put({ step: 4, sending: false });
  await a.wait(2800);
  await a.move(REST[a.layout]);
};

function Header({ step }: { step: number }) {
  return (
    <div className="bk-top">
      <span className="bk-back" data-on={(step > 0 && step < 4) || undefined}>
        <ArrowLeft size={20} aria-hidden="true" />
      </span>
      <span className="bk-business">Northside Studio</span>
      <span className="bk-call">Call</span>
    </div>
  );
}

function Title({ children }: { children: string }) {
  return <span className="bk-title">{children}</span>;
}

export function BookingDemo() {
  return (
    <figure
      className="mk-demo bk-demo m-0"
      role="img"
      aria-label="A customer opens Northside Studio's booking page on a phone, chooses a haircut and a time, answers the studio's one question, and gets a booked confirmation with a Manage appointment button."
    >
      <Stage<S>
        width={560}
        height={500}
        compact={{ below: 560, width: 358, height: 480 }}
        initial={START}
        poster={DONE}
        script={script}
        play="once"
        cursor={{ at: REST, style: "touch" }}
        className="bk"
      >
        {(s, _rect, layout) => (
          <Phone width={layout === "compact" ? 310 : 360} className="bk-phone">
            <div className="bk-screen">
              <Header step={s.step} />
              <div className="bk-track" style={{ transform: `translateX(${-s.step * 402}px)` }}>
                <section className="bk-pane" aria-hidden="true">
                  <Title>What would you like to book?</Title>
                  <div className="bk-list">
                    {SERVICES.map((service) => (
                      <span
                        key={service.name}
                        className="bk-card"
                        data-on={(service.pick && s.service) || undefined}
                        data-target={service.pick ? "service" : undefined}
                      >
                        <span className="bk-card__text">
                          <span className="bk-card__name">
                            {service.name}
                            {service.request ? <span className="bk-badge">Request</span> : null}
                          </span>
                          <span className="bk-card__meta">{service.meta}</span>
                        </span>
                        <CircleCheck className="bk-card__check" size={22} aria-hidden="true" />
                      </span>
                    ))}
                  </div>
                </section>

                <section className="bk-pane" aria-hidden="true">
                  <Title>When works for you?</Title>
                  <div className="bk-days">
                    {DAYS.map(([day, date], i) => (
                      <span key={day} className="bk-day" data-on={i === 0 || undefined}>
                        <span className="bk-day__name">{day}</span>
                        <span className="bk-day__date">{date}</span>
                      </span>
                    ))}
                  </div>
                  <div className="bk-times">
                    {TIMES.map((time) => (
                      <span
                        key={time}
                        className="bk-time"
                        data-on={(s.slot && time === PICK_TIME) || undefined}
                        data-target={time === PICK_TIME ? "time" : undefined}
                      >
                        {time}
                      </span>
                    ))}
                  </div>
                </section>

                <section className="bk-pane" aria-hidden="true">
                  <Title>Before you come</Title>
                  <div className="bk-ask">
                    <span className="bk-ask__q">Any allergies we should know about?</span>
                    <div className="bk-chips">
                      <span className="bk-chip" data-on={s.answer === "no" || undefined} data-target="no">No</span>
                      <span className="bk-chip">Yes</span>
                    </div>
                  </div>
                  <span className="bk-btn" data-ready={s.answer === "no" || undefined} data-target="continue">Continue</span>
                </section>

                <section className="bk-pane" aria-hidden="true">
                  <Title>Your details</Title>
                  <div className="bk-fields">
                    <span className="bk-field" data-focus={(s.step === 3 && s.name.length < NAME.length) || undefined}>
                      <span className="bk-field__label">Full name</span>
                      <span className="bk-field__value">{s.name}</span>
                    </span>
                    <span className="bk-field">
                      <span className="bk-field__label">Mobile number</span>
                      <span className="bk-field__value">98765 43210</span>
                    </span>
                    <span className="bk-field">
                      <span className="bk-field__label">Email address</span>
                      <span className="bk-field__value">riya@example.com</span>
                    </span>
                  </div>
                  <span className="bk-btn" data-ready={s.name === NAME || undefined} data-target="confirm">
                    <States
                      value={s.sending ? "sending" : "idle"}
                      states={{ idle: "Confirm booking", sending: <Spinner size={22} /> }}
                    />
                  </span>
                </section>

                <section className="bk-pane bk-pane--done" aria-hidden="true">
                  <span className="bk-done__mark">
                    <CircleCheck size={28} aria-hidden="true" />
                  </span>
                  <span className="bk-done__title">You’re booked</span>
                  <span className="bk-done__text">Your booking is saved. Use Manage appointment to view the details or make a change.</span>
                  <div className="bk-summary">
                    <span className="bk-row">
                      <CalendarDays size={18} aria-hidden="true" />
                      <span className="bk-row__text">
                        <span className="bk-row__label">Date and time</span>
                        <span className="bk-row__value">Mon, 12 Oct · 11:30</span>
                      </span>
                    </span>
                    <span className="bk-row">
                      <ClipboardList size={18} aria-hidden="true" />
                      <span className="bk-row__text">
                        <span className="bk-row__label">Service</span>
                        <span className="bk-row__value">Haircut · 45 min</span>
                      </span>
                    </span>
                    <span className="bk-row">
                      <UserRound size={18} aria-hidden="true" />
                      <span className="bk-row__text">
                        <span className="bk-row__label">Stylist</span>
                        <span className="bk-row__value">Anika Iyer</span>
                      </span>
                    </span>
                  </div>
                  <span className="bk-btn bk-btn--on">
                    Manage appointment
                    <ArrowRight size={20} aria-hidden="true" />
                  </span>
                </section>
              </div>
            </div>
          </Phone>
        )}
      </Stage>
    </figure>
  );
}
