/**
 * The assistant's rules that live in code, not in the prompt (feature 30). A prompt can be argued with; these cannot.
 * Everything here is pure, so it is tested on its own: emergencies and advice questions get a fixed reply and a handoff
 * before any model runs, what counts as the customer's yes, and a final check on what the model says.
 */

export const MAX_CUSTOMER_CHARS = 1000;
export const MAX_TURNS_PER_CONVERSATION = 40;
export const MAX_TOOL_CALLS_PER_TURN = 6;
export const MAX_MODEL_CALLS_PER_TURN = 8;
export const MAX_REPLY_CHARS = 1500;
/** A proposal waiting for a yes is dropped after this long. The held time lasts five minutes, so a late yes re-checks it. */
export const PROPOSAL_MINUTES = 15;
/** A failed turn counts toward the "fails twice" handoff. */
export const FAILURES_BEFORE_HANDOFF = 2;

/** Customer text is data. Control characters go, and angle brackets are made harmless so it cannot imitate a server note. */
const LEFT_ANGLE = String.fromCharCode(0x2039);
const RIGHT_ANGLE = String.fromCharCode(0x203a);

export function sanitizeCustomerText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\s+/g, " ")
    // Control and format characters (including the ones that flip text direction or hide it).
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/</g, LEFT_ANGLE)
    .replace(/>/g, RIGHT_ANGLE)
    // The system's own notes start with a square-bracket marker, so a customer cannot type one.
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .trim()
    .slice(0, MAX_CUSTOMER_CHARS);
}

// Accents come off Latin letters only; in Hindi and other scripts the marks are part of the letters.
const squash = (text: string): string => text.toLowerCase().normalize("NFKD").replace(/(?<=\p{Script=Latin})\p{M}+/gu, "").replace(/[^\p{L}\p{M}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

// Emergencies: phrases that mean danger now. A bare symptom word ("toothache", "pain") is not one, so "book me in for a
// toothache" still books. Spoken-Hindi spellings are included because the assistant answers in the customer's language.
const emergencyPatterns: readonly RegExp[] = [
  /\b(chest (pain|tightness)|pain in (my )?chest|heart attack|cardiac arrest)\b/,
  /\b(can'?t|cannot|unable to|struggling to|difficulty|trouble) breath(e|ing)?\b/,
  /\b(not breathing|stopped breathing|choking)\b/,
  /\b(having a )?stroke\b.*\b(face|arm|speech|now|symptoms)\b/,
  /\b(overdos(e|ed|ing)|took too many (pills|tablets)|swallowed (poison|bleach))\b/,
  /\b(suicid(e|al)|kill myself|end my life|want to die|hurt myself|self harm)\b/,
  /\b(bleeding (heavily|badly|a lot|profusely)|won'?t stop bleeding|bleeding (and )?(won'?t|will not) stop)\b/,
  /\b(unconscious|unresponsive|passed out|fainted and)\b/,
  /\b(severe allergic|anaphyla(xis|ctic)|throat (is )?(closing|swelling))\b/,
  /\b(it'?s an emergency|this is an emergency|medical emergency|call (an )?ambulance|need an ambulance)\b/,
  /\b(seizure|having a fit)\b/,
  /\b(saans nahi|saans lene mein (dikkat|takleef)|seene mein dard|behosh)\b/,
];

export function isEmergency(text: string): boolean {
  const flat = squash(text);
  return emergencyPatterns.some((pattern) => pattern.test(flat));
}

// Advice-seeking: asking what to take, whether something is safe, or what is wrong with them. Medical, legal and money
// advice are not this assistant's to give. These match the shape of the question, not the topic.
const advicePatterns: readonly RegExp[] = [
  /\bwhat (should|can|could) i (take|use|put|apply|give|eat|drink) (for|on|to (treat|ease|stop|help))\b/,
  /\bwhat (should|can) i do (for|about) (a |an |my |the )?(pain|fever|headache|toothache|cough|cold|rash|infection|swelling|bleeding|burn|bite|sprain|cramps?|nausea|symptoms?)\b/,
  /\bwhich (medicine|medication|tablet|pill|drug|cream|antibiotic|painkiller|ointment)\b/,
  /\b(what|which) (medicine|medication|tablet|pill|drug|antibiotic|painkiller|dose|dosage)\b/,
  /\b(how (much|many)) (should i take|mg|tablets|pills|ibuprofen|paracetamol|dolo)\b/,
  /\b(what|which|how (much|many)) (is |are |the |a |my |his |her |their )?(dose|dosage)\b/,
  /\b(prescri(be|ption) (me|for)|can you prescribe)\b/,
  /\bis it (safe|ok|okay|fine|normal) (to|for me to|if i)\b.*\b(take|eat|drink|use|stop|mix|combine|continue)\b/,
  /\b(can|could|may) i (take|mix|combine|drink|eat|stop taking|use)\b.*\b(medicine|medication|medicines|pills?|tablets?|antibiotics?|painkillers?|ibuprofen|paracetamol|aspirin|alcohol|drugs?|supplements?|vitamins?|ointment|cream)\b/,
  /\b(do|could|might) i have\b.*\b(cancer|infection|diabetes|disease|cavity|fracture|tumou?r|covid|condition)\b/,
  /\b(is (this|it|my)|are (these|my)) .{0,40}\b(cancer|infected|serious|dangerous|a fracture|broken|contagious|an abscess)\b/,
  /\b(diagnos(e|is)|what('s| is) wrong with me|what is causing|what causes my)\b/,
  /\b(legal advice|should i sue|can i sue|is it legal|my lawyer)\b/,
  /\b(tax advice|which stock|should i invest|investment advice|loan advice)\b/,
  /\b(dawai|dawa) (kaun|konsi|kya)\b/,
];

export function isAdviceSeeking(text: string): boolean {
  const flat = squash(text);
  return advicePatterns.some((pattern) => pattern.test(flat));
}

const humanPatterns: readonly RegExp[] = [
  /\b(talk|speak|chat|connect|transfer|put me|pass me|hand me)( me)? (to|with|through to|over to) (a |an |the |your |some ?one |someone )?(real |human |live )?(person|human|people|agent|receptionist|staff|manager|owner|someone|somebody|representative|team|doctor)\b/,
  /\b(real|actual|live) (person|human)\b/,
  /\b(human|person|agent|receptionist|someone) (please|pls)\b/,
  /\b(can|could|will|would) (you|someone|somebody|the team|a person) (please )?(call|ring|phone) me (back|up)?\b/,
  /\b(call|ring|phone) me (back|up)\b/,
  /\b(insaan|insan|kisi (se|insaan) baat)\b/,
];

export function asksForPerson(text: string): boolean {
  const flat = squash(text);
  return humanPatterns.some((pattern) => pattern.test(flat));
}

const upsetPatterns: readonly RegExp[] = [
  /\b(ridiculous|unacceptable|useless|pathetic|disgusting|furious|angry|fed up|sick of|complain(t|ing)?|scam|rubbish|stupid bot|dumb bot|idiot)\b/,
  /\b(you('re| are) not (helping|listening)|this is (not )?(helping|working)|not helpful|wasting my time)\b/,
];
const mildFrustration: readonly RegExp[] = [/\b(frustrat(ed|ing)|annoy(ed|ing)|confus(ed|ing)|again and again|already told you|i said)\b/];

export function soundsUpset(text: string, rule: "balanced" | "eager"): boolean {
  const flat = squash(text);
  if (upsetPatterns.some((pattern) => pattern.test(flat))) return true;
  return rule === "eager" && mildFrustration.some((pattern) => pattern.test(flat));
}

const yes = new Set([
  "yes", "y", "yep", "yeah", "yup", "yes please", "yes confirm", "yes book it", "yes go ahead", "confirm", "confirmed", "please confirm", "i confirm",
  "ok", "okay", "ok confirm", "okay confirm", "sure", "go ahead", "book it", "do it", "that works", "that's right", "thats right", "correct", "sounds good", "perfect",
  "haan", "han", "haa", "ha ji", "haan ji", "ji haan", "ji", "theek hai", "thik hai", "sahi hai", "kar do", "book kar do", "ho jaye", "हाँ", "हां", "ठीक है", "जी", "बुक कर दो",
  "si", "oui", "sim", "ja",
]);
const no = new Set(["no", "n", "nope", "nah", "no thanks", "no thank you", "cancel that", "never mind", "nevermind", "not now", "stop", "dont", "don't", "nahi", "nahin", "mat karo", "नहीं", "नही"]);

/** The customer's whole message is a yes. Anything longer ("yes but make it 5") is not, and is read as a new request. */
export function isAffirmative(text: string): boolean {
  const flat = squash(text).replace(/\s*(👍|✅)\s*/gu, "").trim();
  return flat.length > 0 && flat.length <= 28 && yes.has(flat);
}

export function isNegative(text: string): boolean {
  return no.has(squash(text));
}

export function normalizedForRepeat(text: string): string {
  return squash(text).slice(0, 200);
}

/** The same message three times in a row means the assistant is not getting through. */
export function isRepeating(history: readonly string[], latest: string): boolean {
  const key = normalizedForRepeat(latest);
  if (key.length < 3) return false;
  const recent = history.slice(-4).map(normalizedForRepeat);
  return recent.filter((entry) => entry === key).length >= 2;
}

export function disclosureLine(businessName: string): string {
  return `Hi, I'm ${businessName}'s automated booking assistant, not a person. I can check times and help you book, move or cancel. For anything else I'll pass you to the team.`;
}

export function emergencyReply(phone: string | null): string {
  const call = phone ? ` You can also call ${phone}.` : "";
  return `If this is an emergency, please call your local emergency number (for example 112 or 911) or go to the nearest emergency department right now.${call} I'm an automated assistant and can't help with this, so I'm passing your message to the team.`;
}

export function adviceReply(phone: string | null): string {
  const call = phone ? ` Please call ${phone} to speak to someone` : " Please speak to the team";
  return `I'm an automated booking assistant, so I can't give medical, legal or financial advice.${call}, and in an emergency contact your local emergency number. I've asked the team to follow up. I can still help you book a time.`;
}

export const handoffReply = "I'm passing this to the team. Someone will reply here as soon as they can, and I'll stop replying until then.";

export function capReply(link: string): string {
  return `I can't take more messages right now. You can still book at ${link}.`;
}

const falseCompletion = /\b(i(?:'ve| have|'m| am)|you(?:'re| are)|your (?:appointment|booking|visit|session|class|slot) (?:is|has been)|it(?:'s| is| has been)) (?:now |all |just |already )?(?:booked|confirmed|cancel+ed|rescheduled|moved|set|done|locked in)\b/i;

/**
 * The last check on what the model wrote. When it has just proposed a change, a reply that says the change is already done
 * ("you're booked") would mislead the customer, because nothing happens until they confirm; that sentence is replaced by the
 * proposal and what to do. Other replies are left alone, so "your booking is confirmed for Saturday" stays when it is simply true.
 * Anything over the length limit is cut at a sentence.
 */
export function screenReply(text: string, state: { committed: boolean; proposalSummary: string | null }): string {
  let reply = text.replace(/<\/?[a-z_]+>/gi, "").trim();
  if (!state.committed && state.proposalSummary !== null && falseCompletion.test(reply)) {
    reply = `I haven't changed anything yet. ${state.proposalSummary} Tap Confirm, or reply yes, to go ahead.`;
  }
  if (reply.length > MAX_REPLY_CHARS) {
    const cut = reply.slice(0, MAX_REPLY_CHARS);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    reply = end > 200 ? cut.slice(0, end + 1) : cut;
  }
  return reply;
}
