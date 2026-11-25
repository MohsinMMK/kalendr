"use client";

import { Avatar, Roll, Segmented, Stage, Window, type Act } from "@/components/stageshow";
import type { BusinessTypeId } from "@/lib/business-types";
import { businessTypes } from "@/lib/business-types";

import { capitalize, wordsFor } from "./words";
import "./industries-demo.css";

// One day view, set up three ways. The owner picks a business type (cause), the
// words in the sidebar and the column heads roll to that type's own terms
// (action), and the rows swap to that business's people (result). The terms come
// from business-types.ts, not from this file.

type Pick = 0 | 1 | 2;
type S = { pick: Pick };

const KINDS: readonly { id: BusinessTypeId; business: string; rows: readonly (readonly [string, string, string, string])[] }[] = [
  {
    id: "wellness",
    business: "Northside Studio",
    rows: [
      ["9:30", "Riya Shah", "Anika Iyer", "Haircut"],
      ["10:15", "Priya Menon", "Rohan Das", "Blow-dry"],
      ["11:00", "Arjun Rao", "Meera Nair", "Hair colour"],
    ],
  },
  {
    id: "education",
    business: "Brightpath Tutoring",
    rows: [
      ["3:30", "Kabir", "Farah Ali", "Trial class"],
      ["4:30", "Mira", "Farah Ali", "One-to-one"],
      ["5:30", "Kabir", "Farah Ali", "Exam prep"],
    ],
  },
  {
    id: "dental",
    business: "Lakeview Dental",
    rows: [
      ["9:00", "Aarav Mehta", "Dr Sana Qureshi", "Check-up"],
      ["9:30", "Ira Mehta", "Dr Sana Qureshi", "Cleaning"],
      ["10:30", "Zoya Khan", "Dr Vikram Rao", "Check-up"],
    ],
  },
];

const START: S = { pick: 0 };
const POSTER: S = { pick: 2 };
const REST = { wide: { x: 337, y: 97 }, compact: { x: 124, y: 77 } };

const script = async (a: Act<S>) => {
  await a.wait(1600);
  await a.click({ at: "pick-1", x: 0.9 });
  a.put({ pick: 1 });
  await a.wait(2400);
  await a.click({ at: "pick-2", x: 0.9 });
  a.put({ pick: 2 });
  await a.wait(1200);
};

const shortLabel = (label: string) => label.split(/[ ,]/)[0] ?? label;

export function IndustriesDemo() {
  return (
    <div className="mk-demo ind-demo">
      <Stage<S>
        width={672}
        height={360}
        compact={{ below: 560, width: 358, height: 340 }}
        initial={START}
        poster={POSTER}
        script={script}
        play="once"
        cursor={{ at: REST, style: "arrow" }}
      >
        {(s, _rect, layout) => {
          const compact = layout === "compact";
          const kind = KINDS[s.pick]!;
          const words = wordsFor(kind.id);
          const labels = KINDS.map((k) => businessTypes[k.id].label);
          return (
            <>
              <Window
                className="ind-window"
                                sidebarWidth={compact ? undefined : 148}
                sidebar={compact ? undefined : (
                  <nav className="ind-side">
                    <span className="ind-side__name"><Roll variant="fade">{kind.business}</Roll></span>
                    {["Today", "Schedule", "Bookings"].map((label, i) => (
                      <span key={label} className="ind-side__item" data-active={i === 0 || undefined}>{label}</span>
                    ))}
                    <span className="ind-side__item"><Roll variant="fade">{capitalize(words.customer.plural)}</Roll></span>
                    <span className="ind-side__item">Settings</span>
                  </nav>
                )}
              >
                <div className="ind-day">
                  <Segmented
                className="ind-pick"
                value={s.pick}
                items={labels.map((label) => (compact ? shortLabel(label) : label))}
                targets={["pick-0", "pick-1", "pick-2"]}
                cursor="pointer"
              />
                  <div className="ind-day__head">
                    <span className="ind-day__title">Today</span>
                    <span className="ind-day__count">3 <Roll variant="fade">{words.booking.plural}</Roll></span>
                  </div>
                  <div className="ind-grid ind-grid--head">
                    <span>Time</span>
                    <Roll variant="fade">{capitalize(words.customer.singular)}</Roll>
                    <Roll variant="fade">{capitalize(words.provider.singular)}</Roll>
                    <Roll variant="fade">{capitalize(words.booking.singular)}</Roll>
                  </div>
                  <div className="ind-layers">
                    {KINDS.map((k, ki) => (
                      <div key={k.id} className="ind-layer" data-on={ki === s.pick || undefined} aria-hidden>
                        {k.rows.map(([time, who, by, what], i) => (
                          <div key={i} className="ind-grid ind-grid--row" data-fresh={i === 0 || undefined}>
                            <span className="ind-time">{time}</span>
                            <span className="ind-who">{compact ? null : <Avatar name={who} size={22} />}{who}</span>
                            <span className="ind-by">{by}</span>
                            <span className="ind-what">{what}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </Window>
            </>
          );
        }}
      </Stage>
    </div>
  );
}
