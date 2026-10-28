// lib/reply-categories.js
// Sorts a reply into a category (Interested, Out of office, Remove me, …) and a group:
// "positive", "negative" or "review" (no match, check by hand).
//
// Order of checks:
//  1. Automatic replies and opt-outs (bounce, remove me, vacation, out of office) are matched from the
//     reply itself first: they're unambiguous.
//  2. Otherwise Smartlead's own lead category, if the API ever sends one.
//  3. Otherwise the reply text is matched against the phrases below.
//  4. Anything left is "Needs review".
// Referrals ("talk to my colleague", "I've forwarded this") count as Not interested.
// To tune it, add phrases to the lists below. Category keys must match public/report.js.

export const CATEGORIES = {
  interested:     { label: "Interested",                  group: "positive" },
  meeting:        { label: "Meeting request",             group: "positive" },
  info:           { label: "Information request",         group: "positive" },
  not_interested: { label: "Not interested",              group: "negative" },
  not_now:        { label: "Not now / later",             group: "negative" },
  unsubscribe:    { label: "Remove me / unsubscribe",     group: "negative" },
  out_of_office:  { label: "Out of office",               group: "negative" },
  vacation:       { label: "Vacation / on leave",         group: "negative" },
  wrong_person:   { label: "Wrong person / left company", group: "negative" },
  bounce:         { label: "Bounce / delivery failure",   group: "negative" },
  review:         { label: "Needs review",                group: "review" },
};

const any = (text, list) => list.some((re) => re.test(text));

// Text is lower-cased and curly apostrophes are straightened before matching.
const BOUNCE = [
  /\bdelivery (has )?failed\b/,
  /\bundeliverable\b/,
  /\bundelivered mail\b/,
  /\bmail delivery (subsystem|failed|failure)\b/,
  /\bdelivery status notification\b/,
  /\baddress (was )?not found\b/,
  /\brecipient address rejected\b/,
  /\bcould(n't| not) be delivered\b/,
  /\bwas(n't| not) delivered\b/,
  /\bmailbox (is )?(unavailable|full|not found|does not exist)\b/,
  /\b(no such user|user unknown)\b/,
  /\bmailer-daemon\b/,
];

const UNSUBSCRIBE = [
  /^\s*(stop|unsubscribe|remove)\b/,
  /\bunsubscrib/,
  /\bremove (me|us|my (email|address|details|name|contact)|our (email|address|details)|this (email|address))\b/,
  /\btake (me|us|my (email|name)) off\b/,
  /\boff (your|the) (mailing |email |contact )?(list|database)\b/,
  /\bstop (emailing|e-mailing|contacting|sending|messaging|spamming)\b/,
  /\b(do not|don't|never) (contact|email|e-mail|message|spam) (me|us)\b/,
  /\bdo not contact\b/,
  /\bopt(ed)? (me |us )?out\b/,
  /\bdelete (my|our) (data|email|details|information|contact)\b/,
  /\bno (more|further) (emails|e-mails|contact|messages|follow[- ]?ups)\b/,
];

const VACATION = [
  /\bon (annual |parental |maternity |paternity |sick |medical |personal |holiday |vacation |study )?leave\b/,
  /\b(on|enjoying (a|my|some)) (vacation|holidays?)\b/,
  /\b(annual|maternity|paternity|parental|sick|medical) leave\b/,
  /\b(public|bank|national) holiday\b/,
  /\bsabbatical\b/,
  /\b(out|away) (on|for) (leave|vacation|holidays?)\b/,
  /\bvacation (until|till|through|from)\b/,
];

const OUT_OF_OFFICE = [
  /\bout of (the )?office\b/,
  /\booo\b/,
  /\baway from (the |my )?(office|desk|e-?mail|inbox|computer)\b/,
  /\bauto(matic|mated)?[- ]?(reply|response|responder)\b/,
  /\bautoreply\b/,
  /\blimited (access to (my )?e-?mail|e-?mail access|connectivity)\b/,
  /\b(currently|presently) (away|travell?ing|unavailable)\b/,
  /\b(back|returning|i return)( to (the )?(office|work))? (on|by|after|from) (mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/,
  /\bback in the office\b/,
  /\b(respond|reply|get back to you)( to your (e-?mail|message))? (when|upon|once|on) (i|my) return\b/,
  /\b(will|i'll) (have|get) (limited|no) access\b/,
];

const WRONG_PERSON = [
  /\bno longer (with|at|employed|part of|working (at|for|with)|works? (at|for|here))\b/,
  /\b(has|have) (now )?left (the|our) (company|organi[sz]ation|business|firm|team)\b/,
  /\bleft the (company|organi[sz]ation|business|firm)\b/,
  /\b(wrong|not the (right|correct|best|appropriate)) (person|contact|email|department|team)\b/,
  /\bnot (my|in my) (area|department|remit|responsibility|role)\b/,
  /\b(i'm|i am) not (responsible|the (right )?decision[- ]maker|involved|the person)\b/,
  /\b(i|we) (don't|do not) (handle|deal with|look after|manage) (this|that|these)\b/,
  /\b(this|the) (e-?mail|mailbox|inbox|address) is (no longer|not) (monitored|active|in use|checked)\b/,
  /\bretired\b/,
];

// Pointing us to someone else. Counted as Not interested.
const REFERRAL = [
  /\b(please|kindly) (reach out to|contact|email|e-mail|speak (to|with)|get in touch with|connect with|write to)(?! (me|us)\b)/,
  /\byou (should|could|can|may want to|might want to) (reach out to|contact|speak (to|with)|try|email|get in touch with)(?! (me|us)\b)/,
  /\b(i've|i have|i'll|i will|i am|i'm) (forwarded|forwarding|cc'?d|cc'?ing|copied|copying|looped in|looping in|passed (this|it|your)|passing (this|it|your))\b/,
  /\b(best|right) person (to (speak|talk) (to|with)|for this|is|would be)\b/,
];

const NOT_INTERESTED = [
  /\bnot (really |that |too |very |at all |currently )?interested\b/,
  /\b(no|zero|little) interest\b/,
  /\bnot (a |the )?(good |great |right )?fit\b/,
  /\bno,? thank(s| you)\b/,
  /\bnot for (us|me)\b/,
  /\b(we'll|we will|i'll|i will) pass\b/,
  /\bpass on this\b/,
  /\bnot relevant\b/,
  /^\s*(no|nope|nah)[\s.!,]*($|thanks?\b|thank you\b|not\b)/,
];

const NOT_NOW = [
  /\bnot (right )?now\b/,
  /\bnot at (this|the) (time|moment|stage|point)\b/,
  /\bmaybe (later|next (week|month|quarter|year)|in the (future|new year))\b/,
  /\b(reach|circle|check) (back|out) (in|next|after|later)\b/,
  /\b(try|contact|ping|email) (me |us )?(again )?(in|next) (a (few|couple)|\d+|q[1-4]|quarter|year|month)/,
  /\bno budget\b/,
  /\bbudgets? (is |are )?(frozen|tight|allocated|closed|spent)\b/,
  /\b(bad|wrong) timing\b/,
  /\btiming (isn't|is not) right\b/,
  /\bnot (a )?priority\b/,
  /\b(down|on) the (road|line)\b/,
];

const MEETING = [
  /\b(book|schedule|set up|setup|arrange|organi[sz]e|find|grab) (a |some )?(call|meeting|time|slot|chat|demo|zoom|teams call)\b/,
  /\bcalendly\b/,
  /\b(send|share) (me |us |over )?(an? |your )?(invite|calendar( invite| link)?|booking link|meeting link)\b/,
  /\blet's (talk|chat|connect|meet|speak|set|schedule|discuss|jump|hop|find)\b/,
  /\bhappy to (talk|chat|connect|meet|speak|jump|hop|discuss|have a call)\b/,
  /\b(hop|jump) on a (quick )?(call|zoom|chat)\b/,
  /\b(i'm|i am|we're|we are) (free|available) (on|at|for|tomorrow|next|this|mon|tue|wed|thu|fri)/,
  /\bwhat time (works|suits)\b/,
  /\bwhen (are you|would you be) (free|available)\b/,
  /\bwhen is a good time\b/,
  /\b(quick|short|brief|\d+[- ]?min(ute)?s?) (call|chat|meeting)\b/,
  /\bdemo\b/,
];

// Softer "no" phrases, checked after meeting requests ("we already have an agency, but happy to chat").
const SOFT_NO = [
  /\bwe('re| are) (all )?(good|set|covered|sorted|fine)\b/,
  /\b(already|currently) (have|using|use|work(ing)? with|partner(ed)? with)\b/,
  /\bnot (looking|in the market)\b/,
  /\b(don't|do not|doesn't|does not) (need|require|want)\b/,
  /\bno (need|requirement)\b/,
  /\bhappy with (our|my|the) (current|existing)\b/,
];

const INFO = [
  /\b(pricing|prices?|costs?|quote|fees?|how much)\b/,
  /\b(send|share|forward|email) (me |us |over )?(some |more |the |a |your )?(info|information|details|deck|brochure|case stud(y|ies)|proposal|examples?|portfolio|one[- ]pager|samples?)\b/,
  /\bmore (info|information|details)\b/,
  /\b(can|could|would) you (share|send|explain|tell me|elaborate|clarify)\b/,
  /\bwhat (exactly )?(do you|does (it|this|your)|is (the|your))\b/,
  /\bhow (does|do) (it|this|you|your)\b/,
];

const INTERESTED = [
  /\binterest(ed|ing)\b/,
  /\bsounds (good|great|interesting|promising)\b/,
  /\btell me more\b/,
  /\b(i'd|i would|we'd|we would) (like|love) to (know|learn|hear|see|explore|try|discuss)\b/,
  /\b(keen|intrigued|curious)\b/,
  /\byes,? please\b/,
  /\b(go ahead|please proceed)\b/,
  /\bcount (me|us) in\b/,
  /\blooks (good|great|interesting)\b/,
  /^\s*(yes|yep|yeah|sure|ok|okay|absolutely|definitely|why not)\b/,
];

// Smartlead's category names (default set) → our keys. "Not interested" must come before "interested".
const SMARTLEAD_NAMES = [
  [/meeting/i, "meeting"],
  [/information|info request/i, "info"],
  [/not\s*interested/i, "not_interested"],
  [/do\s*not\s*contact|unsubscrib/i, "unsubscribe"],
  [/out\s*of\s*office|\booo\b/i, "out_of_office"],
  [/wrong\s*person/i, "wrong_person"],
  [/bounce/i, "bounce"],
  [/interested/i, "interested"],
];

function smartleadKey(name) {
  if (!name) return null;
  for (const [re, key] of SMARTLEAD_NAMES) if (re.test(String(name))) return key;
  return null;
}

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[ \t]+/g, " ");
}

// Drop quoted lines and any line copied from the email we sent, so words from our own
// email (an unsubscribe footer, "interested?" in our copy) don't decide the category.
function stripOurText(text, sentBody) {
  const ours = new Set(
    String(sentBody || "").toLowerCase().split(/\n+/).map((l) => l.trim()).filter((l) => l.length >= 20)
  );
  return String(text || "")
    .split("\n")
    .filter((line) => {
      const l = line.trim().toLowerCase();
      if (l.startsWith(">")) return false;
      return !(l.length >= 20 && ours.has(l));
    })
    .join("\n");
}

function automatic(t) {
  if (any(t, BOUNCE)) return "bounce";
  if (any(t, UNSUBSCRIBE)) return "unsubscribe";
  if (any(t, VACATION)) return "vacation";
  if (any(t, OUT_OF_OFFICE)) return "out_of_office";
  return null;
}

function fromWords(t) {
  const referral = any(t, REFERRAL);
  if (any(t, WRONG_PERSON)) return referral ? "not_interested" : "wrong_person";
  if (any(t, NOT_INTERESTED)) return "not_interested";
  if (any(t, NOT_NOW)) return "not_now";
  if (any(t, MEETING)) return "meeting";
  if (any(t, SOFT_NO)) return "not_interested";
  if (any(t, INFO)) return "info";
  if (any(t, INTERESTED)) return "interested";
  if (referral) return "not_interested";
  return null;
}

/**
 * text:              the new part of the reply (quoted thread already removed)
 * subject:           the reply's own subject, if Smartlead gives one (only used to spot auto-replies)
 * sentBody:          the email we sent (lines copied from it are ignored)
 * smartleadCategory: Smartlead's lead category name, if the API sent one
 * Returns { key, label, group, source } where source is "reply text", "smartlead" or "none".
 */
export function classifyReply({ text = "", subject = "", sentBody = "", smartleadCategory = null } = {}) {
  const body = normalize(stripOurText(text, sentBody)).trim();
  const subj = normalize(subject);

  let key = automatic(`${subj}\n${body}`);
  let source = key ? "reply text" : null;

  const tagged = smartleadKey(smartleadCategory);
  if (!key && tagged) { key = tagged; source = "smartlead"; }

  if (!key && body) {
    key = fromWords(body);
    if (key) source = "reply text";
  }
  if (!key) { key = "review"; source = "none"; }

  // Smartlead has a single "Out Of Office" tag; split out vacations and leave using the text.
  if (key === "out_of_office" && any(body, VACATION)) key = "vacation";

  const c = CATEGORIES[key];
  return { key, label: c.label, group: c.group, source };
}
