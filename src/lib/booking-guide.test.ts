import { describe, expect, it } from "vitest";

import {
  bookingGuideSchema,
  cleanGuideAnswers,
  decodeGuideAnswers,
  encodeGuideAnswers,
  guideSummary,
  matchGuide,
  newGuideId,
  parseStoredGuide,
  publicGuide,
  starterGuide,
  type BookingGuide,
} from "./booking-guide";

const services = [
  { id: "cut", name: "Haircut", category: "Hair", durationMinutes: 30, practitionerIds: ["asha", "ben"] },
  { id: "colour", name: "Colour", category: "Hair", durationMinutes: 90, practitionerIds: ["asha"] },
  { id: "facial", name: "Facial", category: "Skin", durationMinutes: 60, practitionerIds: ["cara"] },
];
const people = [{ id: "asha" }, { id: "ben" }, { id: "cara" }];

const guide: BookingGuide = {
  isActive: true,
  title: "Help me choose",
  intro: "",
  questions: [
    {
      id: "need",
      label: "What do you need?",
      multiple: true,
      options: [
        { id: "hair", label: "Hair", serviceIds: ["cut", "colour"] },
        { id: "skin", label: "Skin", serviceIds: ["facial"] },
        { id: "unsure", label: "Not sure", serviceIds: [] },
      ],
    },
    {
      id: "time",
      label: "How long?",
      multiple: false,
      options: [
        { id: "short", label: "Short", serviceIds: ["cut"] },
        { id: "long", label: "Long", serviceIds: ["colour", "facial"] },
      ],
    },
  ],
};

describe("bookingGuideSchema", () => {
  it("accepts a guide and trims its words", () => {
    const parsed = bookingGuideSchema.parse({ ...guide, title: "  Help me choose  " });
    expect(parsed.title).toBe("Help me choose");
    expect(parsed.questions).toHaveLength(2);
  });

  it("refuses a question with one answer or the same answer twice", () => {
    const one = bookingGuideSchema.safeParse({ ...guide, questions: [{ ...guide.questions[0], options: [guide.questions[0].options[0]] }] });
    expect(one.success).toBe(false);
    const twice = bookingGuideSchema.safeParse({
      ...guide,
      questions: [{ ...guide.questions[1], options: [{ id: "a", label: "Short", serviceIds: [] }, { id: "b", label: "short", serviceIds: [] }] }],
    });
    expect(twice.success).toBe(false);
  });

  it("refuses a guide with no questions or a shared question id", () => {
    expect(bookingGuideSchema.safeParse({ ...guide, questions: [] }).success).toBe(false);
    expect(bookingGuideSchema.safeParse({ ...guide, questions: [guide.questions[0], { ...guide.questions[1], id: "need" }] }).success).toBe(false);
  });

  it("reads a stored guide, and nothing from a broken one", () => {
    expect(parseStoredGuide(guide)?.title).toBe("Help me choose");
    expect(parseStoredGuide(null)).toBeNull();
    expect(parseStoredGuide({ title: "x" })).toBeNull();
  });
});

describe("matchGuide", () => {
  it("shows everything when nothing is answered", () => {
    const match = matchGuide(guide, {}, services, people);
    expect(match.narrowed).toBe(false);
    expect(match.services).toHaveLength(3);
    expect(match.people).toHaveLength(3);
  });

  it("joins the answers within a question", () => {
    const match = matchGuide(guide, { need: ["hair", "skin"] }, services, people);
    expect(match.services.map((service) => service.id)).toEqual(["cut", "colour", "facial"]);
    expect(match.narrowed).toBe(true);
  });

  it("needs a service to fit every question", () => {
    const match = matchGuide(guide, { need: ["hair"], time: ["long"] }, services, people);
    expect(match.services.map((service) => service.id)).toEqual(["colour"]);
    expect(match.people.map((person) => person.id)).toEqual(["asha"]);
  });

  it("lets an answer with no services narrow nothing", () => {
    const match = matchGuide(guide, { need: ["unsure"], time: ["short"] }, services, people);
    expect(match.services.map((service) => service.id)).toEqual(["cut"]);
    expect(match.people.map((person) => person.id)).toEqual(["asha", "ben"]);
  });

  it("can match nothing", () => {
    const match = matchGuide(guide, { need: ["skin"], time: ["short"] }, services, people);
    expect(match.services).toEqual([]);
    expect(match.people).toEqual([]);
    expect(match.narrowed).toBe(true);
  });
});

describe("answers", () => {
  it("drops answers the guide does not offer and keeps one for a pick-one question", () => {
    expect(cleanGuideAnswers(guide, { need: ["hair", "gone"], time: ["short", "long"], other: ["x"] })).toEqual({ need: ["hair"], time: ["short"] });
  });

  it("lists what the customer chose, in the guide's order", () => {
    expect(guideSummary(guide, { time: ["long"], need: ["skin", "hair"] })).toEqual([
      { id: "need", question: "What do you need?", chosen: ["Hair", "Skin"] },
      { id: "time", question: "How long?", chosen: ["Long"] },
    ]);
  });
});

describe("answers in a link", () => {
  it("round-trips, and skips questions with no answer", () => {
    const text = encodeGuideAnswers({ need: ["hair", "skin"], time: ["long"], empty: [] });
    expect(text).toBe("need.hair.skin~time.long");
    expect(decodeGuideAnswers(text)).toEqual({ need: ["hair", "skin"], time: ["long"] });
  });

  it("reads nothing from an empty or broken link", () => {
    expect(decodeGuideAnswers(null)).toEqual({});
    expect(decodeGuideAnswers("~need~.~")).toEqual({});
  });
});

describe("publicGuide", () => {
  it("hides a guide that is off", () => {
    expect(publicGuide({ ...guide, isActive: false }, ["cut", "colour", "facial"])).toBeNull();
    expect(publicGuide(null, [])).toBeNull();
  });

  it("drops answers whose services are gone, and questions left with one answer", () => {
    const shown = publicGuide(guide, ["cut", "colour"]);
    expect(shown?.questions.map((question) => question.id)).toEqual(["need", "time"]);
    expect(shown?.questions[0].options.map((option) => option.id)).toEqual(["hair", "unsure"]);
    expect(shown?.questions[1].options.map((option) => option.serviceIds)).toEqual([["cut"], ["colour"]]);

    const less = publicGuide(guide, ["cut"]);
    expect(less?.questions.map((question) => question.id)).toEqual(["need"]);
    expect(publicGuide(guide, [])).toBeNull();
  });
});

describe("starterGuide", () => {
  it("asks by category and by time, and passes the checks", () => {
    const starter = starterGuide("wellness", services);
    expect(starter.questions[0].options.map((option) => option.label)).toEqual(["Hair", "Skin", "I'm not sure"]);
    expect(starter.questions[0].options[0].serviceIds).toEqual(["cut", "colour"]);
    expect(starter.questions[1].options[0].serviceIds).toEqual(["cut"]);
    expect(bookingGuideSchema.safeParse(starter).success).toBe(true);
  });

  it("asks by service when there are no categories", () => {
    const starter = starterGuide("other", services.map((service) => ({ ...service, category: undefined })));
    expect(starter.questions[0].options.map((option) => option.label)).toEqual(["Haircut", "Colour", "Facial", "I'm not sure"]);
  });

  it("makes ids that are not taken", () => {
    expect(newGuideId("q", [{ id: "q1" }, { id: "q3" }])).toBe("q4");
    expect(newGuideId("a", [])).toBe("a1");
  });
});
