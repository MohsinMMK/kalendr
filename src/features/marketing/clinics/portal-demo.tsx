"use client";

import { Phone, Roll, Stage, Toast, Window, type Act } from "@/components/stageshow";
import { recordKindLabels } from "@/lib/visit-records";

import "./portal-demo.css";

// A prescription reaches the patient. A doctor shares it from Records (cause);
// the patient signs in to the portal with a one-time code (action); the
// prescription is waiting under Documents and opens (result). The portal's own
// words: "Enter your code", "Your care", Visits, Doctors, Documents, Open.

type Screen = "code" | "care" | "docs" | "doc";
type S = { shared: boolean; digits: number; screen: Screen };

const START: S = { shared: false, digits: 0, screen: "code" };
const POSTER: S = { shared: true, digits: 6, screen: "doc" };
const REST = { wide: { x: 150, y: 250 }, compact: { x: 120, y: 330 } };

const script = async (a: Act<S>) => {
  await a.wait(1200);
  await a.click("share");
  a.put({ shared: true });
  await a.wait(1800);
  for (let i = 1; i <= 6; i++) {
    a.put({ digits: i });
    await a.wait(170);
  }
  await a.wait(300);
  await a.click("signin");
  a.put({ screen: "care" });
  await a.wait(1400);
  await a.click("tab-docs");
  a.put({ screen: "docs" });
  await a.wait(1000);
  await a.click("open");
  a.put({ screen: "doc" });
  await a.wait(2600);
};

const PIN = "482915";
const ROWS = [
  { kind: "Visit note", who: "Zoya Khan", shared: true },
  { kind: "Prescription", who: "Aarav Mehta", shared: false, target: true },
  { kind: "Report", who: "Dev Malhotra", shared: true },
] as const;

export function PortalDemo() {
  return (
    <div className="mk-demo cl-demo">
      <Stage<S>
        width={672}
        height={360}
        compact={{ below: 560, width: 358, height: 360 }}
        initial={START}
        poster={POSTER}
        script={script}
        play="once"
        cursor={{ at: REST, style: "touch" }}
      >
        {(s, _rect, layout) => {
          const compact = layout === "compact";
          return (
            <>
              {compact ? null : (
                <Window className="cl-window">
                  <div className="cl-records">
                    <p className="cl-records__title">Records</p>
                    <div className="cl-records__head">
                      <span>Patient</span>
                      <span>Document</span>
                      <span>Status</span>
                    </div>
                    {ROWS.map((row) => {
                      const shared = row.shared || (s.shared && "target" in row);
                      return (
                        <div key={row.who} className="cl-records__row" data-fresh={"target" in row || undefined}>
                          <span className="cl-records__who">{row.who}</span>
                          <span className="cl-records__doc">{row.kind}</span>
                          <span className="cl-records__status" data-shared={shared || undefined} data-target={"target" in row ? "share" : undefined}>
                            <Roll variant="fade">{shared ? "Shared" : "Draft"}</Roll>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="cl-toastbox"><Toast show={s.shared && s.screen === "code"}>Shared with Aarav Mehta</Toast></div>
                </Window>
              )}

              <Phone width={compact ? 280 : 270} className="cl-phone">
                <div className="cl-screens">
                  <div className="cl-screen" data-on={s.screen === "code" || undefined}>
                    <p className="cl-title">Enter your code</p>
                    <p className="cl-sub">For aarav.mehta@example.com.</p>
                    <div className="cl-pin">
                      {PIN.split("").map((digit, i) => (
                        <span key={i} className="cl-pin__box" data-filled={i < s.digits || undefined}>{i < s.digits ? digit : ""}</span>
                      ))}
                    </div>
                    <span className="cl-btn" data-target="signin" data-ready={s.digits === 6 || undefined}>Sign in</span>
                  </div>

                  <div className="cl-screen" data-on={s.screen !== "code" || undefined}>
                    <p className="cl-title">Your care</p>
                    <div className="cl-tabs">
                      <span data-on={s.screen === "care" || undefined}>Visits</span>
                      <span>Doctors</span>
                      <span data-on={s.screen !== "care" || undefined} data-target="tab-docs">Documents</span>
                      <span>Devices</span>
                    </div>
                    <div className="cl-panel" data-on={s.screen === "care" || undefined}>
                      <span className="cl-label">Upcoming</span>
                      <div className="cl-card">
                        <span className="cl-card__when">Thu 15 Oct · 10:30</span>
                        <span className="cl-card__what">Check-up</span>
                        <span className="cl-card__sub">Dr Sana Qureshi · Lakeview Dental</span>
                        <span className="cl-badge">Booked</span>
                      </div>
                    </div>
                    <div className="cl-panel" data-on={s.screen === "docs" || s.screen === "doc" || undefined}>
                      <span className="cl-label">Aarav Mehta</span>
                      <div className="cl-card">
                        <span className="cl-card__what">Prescription</span>
                        <span className="cl-card__sub">Dr Sana Qureshi · 12 Oct · 1 file</span>
                        <span className="cl-badge cl-badge--line">{recordKindLabels.prescription}</span>
                        <span className="cl-open" data-target="open">Open</span>
                      </div>
                    </div>
                  </div>

                  <div className="cl-sheet" data-on={s.screen === "doc" || undefined}>
                    <span className="cl-sheet__grab" />
                    <p className="cl-title cl-title--sheet">Prescription</p>
                    <p className="cl-sub">Prescription · Dr Sana Qureshi · 12 Oct</p>
                    <span className="cl-file">prescription.pdf</span>
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
