"use client";

import { Avatar, Button, Collapse, Icon, Roll, Row, Spinner, Stage, States, Text, Window, type Act } from "@/components/stageshow";

import "./access-demo.css";

// What "limit someone to one location" does, in three beats on one screen.
// Cause: an owner opens "Access for Sameer Joshi", picks the Receptionist role and
// Banjara Hills (of two locations), and presses Save access. Result: Sameer's own
// Schedule loses its Location filter and lists only Banjara Hills appointments, and the
// change is the newest line in the Activity log. Plays once and holds on that
// frame, which is also the poster. Real strings: Access for, Role, Locations,
// All locations, Save access, Cancel, Schedule, Location, the visit rows, Activity.
// The line in Activity is the product's own wording for a role change.

type S = { rows: boolean; open: boolean; role: "billing" | "receptionist"; places: "all" | "one"; saving: boolean; saved: boolean; logged: boolean };

const START: S = { rows: false, open: false, role: "billing", places: "all", saving: false, saved: false, logged: false };
const DONE: S = { rows: true, open: true, role: "receptionist", places: "one", saving: false, saved: true, logged: true };
const REST = { wide: { x: 600, y: 330 }, compact: { x: 330, y: 300 } };

const script = async (a: Act<S>) => {
  await a.wait(900);
  a.put({ open: true });
  await a.wait(1100);
  await a.click("role");
  a.put({ role: "receptionist" });
  await a.wait(700);
  await a.click("places");
  a.put({ places: "one" });
  await a.wait(700);
  await a.click("save");
  a.put({ saving: true });
  await a.wait(900);
  a.mark("saved");
  a.put({ saving: false, saved: true });
  await a.wait(900);
  a.put({ rows: true });
  await a.wait(900);
  a.put({ logged: true });
  await a.move(REST[a.layout]);
  await a.wait(3000);
};

const JUBILEE = [
  { time: "10:00", name: "Arjun Rao", what: "Beard trim · 30 min" },
  { time: "11:00", name: "Kabir Sen", what: "Haircut · 45 min" },
  { time: "12:30", name: "Neel Kapoor", what: "Blow-dry · 30 min" },
];
const BANJARA = [
  { time: "10:00", name: "Riya Shah", what: "Haircut · 45 min" },
  { time: "11:30", name: "Priya Menon", what: "Hair colour · 90 min" },
  { time: "1:30", name: "Tara Bose", what: "Blow-dry · 30 min" },
];

const ROLE_NAME = { billing: "Billing", receptionist: "Receptionist" } as const;

function Visits({ rows }: { rows: typeof JUBILEE }) {
  return (
    <div className="tr-visits">
      {rows.map((row) => (
        <Row
          key={row.time}
          pad={8}
          lead={<Avatar name={row.name} size={26} />}
          title={<Text>{row.name}</Text>}
          subtitle={<Text>{row.what}</Text>}
          meta={<span className="tr-time">{row.time}</span>}
        />
      ))}
    </div>
  );
}

function SelectBox({ label, target, children }: { label: string; target: string; children: React.ReactNode }) {
  return (
    <div className="tr-field">
      <Text className="tr-label">{label}</Text>
      <div className="tr-select" data-target={target} data-cursor="pointer">
        <span className="tr-select__value">{children}</span>
        <Icon name="chevron-down" size={14} />
      </div>
    </div>
  );
}

export function AccessDemo() {
  return (
    // One picture to assistive tech: the moving faux controls inside would read as noise
    <div
      role="img"
      aria-label="An owner opens Sameer Joshi's access, picks the Receptionist role, limits him to Banjara Hills and saves. His Schedule then lists only Banjara Hills appointments, and the change shows in the Activity log."
    >
      <Stage<S>
        width={672}
        height={400}
        compact={{ below: 560, width: 358, height: 622 }}
        initial={START}
        poster={DONE}
        script={script}
        play="once"
        cursor={{ at: REST, style: "arrow" }}
        className="tr-access"
      >
        {(s, _rect, layout) => {
          const compact = layout === "compact";
          return (
            <>
              <Window
                className="tr-window"
                title="Schedule"
                sidebarWidth={compact ? undefined : 124}
                sidebar={compact ? undefined : (
                  <nav className="tr-side">
                    <span className="tr-side__name">Northside Studio</span>
                    <span className="tr-side__me"><Avatar name="Sameer Joshi" size={18} /> Sameer Joshi</span>
                    {[40, 56, 48, 44, 52].map((w, i) => (
                      <span key={i} className="tr-side__item" data-active={i === 1 || undefined}>
                        <span className="tr-side__dot" />
                        <span className="tr-side__bar" style={{ width: w }} />
                      </span>
                    ))}
                  </nav>
                )}
              >
                <div className="tr-schedule">
                  <div className="tr-schedule__head">
                    <span className="tr-day">Mon 12 Oct</span>
                    <span className="tr-count">
                      <Roll>{s.saved ? "3 appointments" : "3 appointments · Jubilee Hills"}</Roll>
                    </span>
                  </div>
                  <Collapse open={!s.saved}>
                    <div className="tr-filter">
                      <Text className="tr-label">Location</Text>
                      <div className="tr-select tr-select--small">
                        <span className="tr-select__value">Jubilee Hills</span>
                        <Icon name="chevron-down" size={14} />
                      </div>
                    </div>
                  </Collapse>
                  <div className="tr-layers">
                    <div className="tr-layer" data-on={!s.rows || undefined}><Visits rows={JUBILEE} /></div>
                    <div className="tr-layer" data-on={s.rows || undefined}><Visits rows={BANJARA} /></div>
                  </div>
                </div>
              </Window>

              <section className="tr-panel" data-target="panel" data-open={s.open || undefined}>
                <Text className="tr-title">Access for Sameer Joshi</Text>
                <Text className="tr-hint">Pick a role, then switch single permissions on or off.</Text>
                <SelectBox label="Role" target="role">
                  <Roll>{ROLE_NAME[s.role]}</Roll>
                </SelectBox>
                <SelectBox label="Locations" target="places">
                  <Roll>{s.places === "all" ? "All locations" : "Banjara Hills"}</Roll>
                </SelectBox>
                <div className="tr-actions">
                  <Button variant="ghost" size="medium">Cancel</Button>
                  <Button variant="primary" size="medium" data-target="save">
                    <States value={s.saving ? "saving" : "idle"} states={{ idle: "Save access", saving: <Spinner size={14} /> }} />
                  </Button>
                </div>
              </section>

              <aside className="tr-log" data-show={s.logged || undefined} aria-hidden="true">
                <Text className="tr-log__title">Activity</Text>
                <div className="tr-log__row">
                  <Avatar name="Anika Iyer" size={24} />
                  <div className="tr-log__text">
                    <span className="tr-log__line"><strong>Anika Iyer</strong> changed Sameer Joshi&apos;s role</span>
                    <span className="tr-log__change">Role: Billing → Receptionist</span>
                  </div>
                  <span className="tr-log__time">10:42 am</span>
                </div>
              </aside>
            </>
          );
        }}
      </Stage>
    </div>
  );
}
