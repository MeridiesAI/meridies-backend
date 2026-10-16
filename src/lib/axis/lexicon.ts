/**
 * The vocabulary AxIS understands without a model: how counselors phrase each
 * kind of request, which record or catalog attribute a question asks about,
 * the words that turn a lookup into a judgement call, and the jargon expanded
 * before a document search. Patterns run on tokens(text).join(" "): lower
 * case, accents folded, punctuation and possessives removed.
 */

export type Intent = "record" | "documents" | "email" | "roster" | "colleges" | "strategy" | "action" | "essay" | "chitchat";
export const INTENTS: readonly Intent[] = ["record", "documents", "email", "roster", "colleges", "strategy", "action", "essay", "chitchat"];

type Feature = readonly [RegExp, number];

/** Weighted evidence for each intent. A message's score for an intent is the sum of the weights that match. */
export const INTENT_FEATURES: Record<Intent, readonly Feature[]> = {
  essay: [
    [/\b(write|draft|rewrite|redo|polish|finish|continue|compose|ghostwrite|reword|rephrase)\b(?: \w+){0,5} (essay|essays|personal statement|statement|supplement|supplemental|why us|paragraph|intro|introduction|conclusion|hook|opening|ending)\b/, 8],
    [/\bmake (her|his|their|the) (essay|statement|supplement) (better|stronger|sound|flow)\b/, 6],
    // Editing the prose, which the change verbs below would otherwise send to perform_action as an "update".
    // Not when the change is to the essay's record ("fix the deadline for her supplement", "edit her essay's title").
    [/\b(edit|revise|improve|fix|tighten|shorten|lengthen|expand|strengthen|tweak|punch up|trim|cut down)\b(?: (?!(?:deadlines?|due|dates?|status|title|prompt|limit|round|link|url|file|folder)\b)\w+){0,5} (essay|essays|personal statement|statement|supplement|supplemental|why us|paragraph|intro|introduction|conclusion|hook|opening|ending)\b(?! (?:deadlines?|due|dates?|status|title|prompt|word limit|round|link|url|file|folder)\b)/, 8],
    [/\b(add|put|insert|change|set|update|replace|swap|rewrite)\b(?: \w+){0,4} (paragraph|sentence|line|intro|introduction|conclusion|hook|opening|ending|wording)\b(?: \w+){0,6} (essay|essays|personal statement|statement|supplement|supplemental|why us)\b/, 8],
    [/\b(add|put|insert|change|set|update|replace|swap)\b(?: \w+){0,4} (essay|essays|personal statement|statement|supplement|supplemental|why us)(?: \w+){0,2} (paragraph|sentence|first line|last line|intro|introduction|conclusion|hook|opening|ending|wording)\b/, 8],
    [/\b(essay|personal statement|statement|supplement)\b(?: \w+){0,3} (to say|to read|so it (says|reads|opens|starts|ends))\b/, 8],
    // Asking for prose by its size or its prompt, without the word "essay": "give me 650 first-person
    // words for her Common App prompt", "answer the UC PIQ about leadership for him". Not a question
    // about a limit ("what's the 650-word limit?", "650 words max") or about a prompt ("answer which
    // prompt she picked", "answer what the PIQ deadline is").
    [/\b(give me|give her|give him|give them|write|produce|generate|draft|create|come up with)\b(?: (?!(?:email|emails|message|messages|note|notes|text|texts|reminder|summary|update|reply|what|whats|which|how|is|the limit)\b)\w+){0,4} (\d{2,4}|a few hundred|few hundred|several hundred) (first person |personal |narrative )?words\b(?! (max|maximum|min|minimum|limit|or less|or fewer|at most|at least|long)\b)/, 8],
    [/\b(write|draft|compose|answer|respond to|generate|produce|fill in)\b(?: (?!(?:email|emails|message|messages|note|notes|text|texts|reminder|task|tasks|which|what|whats|when|whether|who|how|where|why|if)\b)\w+){0,6} (prompt|prompts|piq|piqs|personal insight questions?|why (this|our) (college|school|major))\b(?! (deadlines?|due|dates?|limit|word limit|count|status|she|he|they|picked|chose)\b)/, 8],
    [/\b(in (the )?first person|as if (she|he|they) (wrote|were writing|was writing))\b/, 6],
    // "In her voice" / "from her perspective" only as a way of writing something, not "understand
    // things from her perspective".
    [/\b(write|draft|compose|rewrite|redo|tell|narrate|answer|respond)\b(?: \w+){0,8} (in (her|his|their) (own )?voice|from (her|his|their) (perspective|point of view))\b/, 6],
  ],
  action: [
    [/\b(remind me(?! (what|when|who|which|how|where|why|whether|if|of)\b)|set a reminder|add (a |an )?(task|to do|todo|reminder|item)|create (a |an )?(task|to do|todo|reminder)|on my (list|queue|work queue)|to my (list|queue|work queue))\b/, 7],
    [/\b(draft|write|compose|send) (an? )?(email|message|note|text|update)( \w+){0,2} (to|for)\b/, 7],
    [/\b(email|message|text) (the |her |his |their )?(parents?|family|mom|dad|mother|father|guardians?)\b/, 5],
    [/\bfollow up with\b/, 4],
    [/\bschedule (a |an )?(meeting|call|session|check in)\b/, 5],
    // A request to change something (perform_action), however it is opened.
    [/^(?:(?:please|pls|hey|ok|okay|axis|can you|could you|would you|will you|go ahead and|lets|let us|i need you to|i want you to|now)\s+)*(delete|remove|archive|unarchive|restore|update|change|set|mark|move|rename|edit|add|create|schedule|reschedule|cancel|assign|reassign|invite|resend|pin|unpin|record|log|enter|put|close|reopen|tick|dismiss|accept|decline|approve|send|notify|share|hide|unhide|link|attach|file|bump|push|postpone|extend|clear|drop|book|revoke|void|uninvite|untick|uncheck)\b(?! (in|of|on|rates?|reads?|list|lists)\b)/, 8],
    [/\b(mark|tick off|check off|untick)\b(?: \w+){0,8} (as )?(done|complete|completed|finished|submitted|received|read)\b/, 7],
    [/\b(move|push|bump|reschedule|postpone)\b(?: \w+){0,8} (to|until|back)\b/, 6],
    [/\b(change|update|set)\b(?: \w+){0,10} to\b/, 6],
    [/\b(delete|remove|archive|unarchive)\b/, 4],
  ],
  email: [
    [/\b(email|emails|emailed|inbox|outlook|gmail|thread|replied|reply|replies|respond|responded|wrote back|written back|write back|wrote to me|message from|messages from|sent me|heard back|heard from|hear from|gotten back|got back to|correspondence)\b/, 2.5],
    [/\bdid (her|his|their|the|\w+) (mom|dad|mother|father|parents?|family|guardians?) (ever )?(reply|respond|write|email|send|answer|get back)\b/, 3],
  ],
  documents: [
    [/\b(transcript|transcripts|resume|report card|score report|pdf|document|documents|file|files|upload|uploaded|attachment|attachments|syllabus|school profile|drive|onedrive|google doc|docx|rec letter|recommendation letter|letter of recommendation)\b/, 2.5],
    [/\bon (the|her|his|their) (transcript|resume|report card|score report)\b/, 2],
  ],
  roster: [
    [/\b(who|which students?|which of my students|anyone|anybody|everyone|everybody|all (of )?my students|my students|my roster|my caseload|caseload|roster)\b/, 2],
    [/\b(behind|falling behind|at risk|need attention|needs attention|overdue|stalled|struggling|slipping)\b/, 1.5],
    [/\bhow many students\b/, 3],
  ],
  colleges: [
    [/\b(admit rate|admission rate|acceptance rate|selectivity|middle 50|mid 50|sat range|act range|median sat|average sat|net price|sticker price|tuition|cost of attendance|enrollment|common data set|cds|test optional|test blind|superscore)\b/, 3],
    [/\b(college|colleges|university|universities|school list|college list|reach|target|safety|safeties|reaches|targets)\b/, 1],
    [/\b(ed|ed2|edii|ea|rea|scea|rd|early decision|early action|regular decision)\b/, 1],
  ],
  strategy: [
    [/\b(should|recommend|advice|advise|strategy|strategic|plan|prioriti[sz]e|priority|next steps?|focus on|our focus|worth it|best way|approach|strengthen|improve|boost|ready for|on track)\b|\brecommendations?\b(?! letters?)/, 2.5],
    [/\b(a |an )?(reach|target|safety|likely|match) (for|school for)\b|\b(will|can|could|would) (she|he|they|\w+) (get in|get into|be admitted|be accepted|get accepted|get admitted)\b/, 3],
    [/\bhow (can|should|do|would) (i|we|she|he|they)\b/, 2.5],
    [/\b(compare|comparison|versus|vs|trade off|tradeoff|pros and cons|better|stronger|weaker|strongest|weakest|strengths?|weakness|weaknesses|weak spots?|holes?|concerns?|gaps?|stand out|position|competitive|realistic|chances?|odds|fit for|good fit)\b/, 2],
    [/\bwhy\b/, 1.5],
  ],
  record: [
    [/\b(gpa|grade point|rank|class rank|sat|act|psat|ap|ib|scores?|grades?|courses?|classes|activities|activity|awards?|honors?|major|majors|intended|polygon|strength profile|meeting notes?|notes from|intake|grad year|graduation|class of|high school|test status|essays?)\b/, 1.2],
    [/\b(deadline|deadlines|due|coming up|upcoming|next meeting|status|progress|tasks?)\b/, 1],
  ],
  chitchat: [[/^(?:(?:hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|cool|great|got it|nice|perfect|sounds good|good morning|good afternoon|axis)(?: |$))+$/, 9]],
};

export type Attribute =
  | "gpa" | "sat" | "act" | "tests" | "rank" | "major" | "class_year" | "school"
  | "admit_rate" | "sat_range" | "act_range" | "net_price" | "enrollment" | "deadline";

export const STUDENT_ATTRIBUTES: ReadonlySet<Attribute> = new Set(["gpa", "sat", "act", "tests", "rank", "major", "class_year", "school"]);
export const COLLEGE_ATTRIBUTES: ReadonlySet<Attribute> = new Set(["admit_rate", "sat_range", "act_range", "net_price", "enrollment"]);

export const ATTRIBUTE_PATTERNS: readonly (readonly [Attribute, RegExp])[] = [
  ["admit_rate", /\b(admit rate|admission rate|acceptance rate|accept rate|selectivity|percent admitted|how selective)\b/],
  ["sat_range", /\b(sat (range|middle|median|average|25th|75th|percentiles?)|(middle|mid) 50|median sat|average sat)\b/],
  ["act_range", /\b(act (range|middle|median|average|25th|75th|percentiles?)|median act|average act)\b/],
  ["net_price", /\b(net price|sticker price|tuition|cost of attendance|cost|costs|price|affordab\w*)\b/],
  ["enrollment", /\b(enrollment|how big|undergrads?|undergraduates|size)\b/],
  ["gpa", /\b(gpa|gpas|grade point)\b/],
  ["sat", /\bsat\b/],
  ["act", /\bact\b/],
  ["tests", /\b(test scores?|testing)\b/],
  ["rank", /\b(class rank|rank|ranking)\b/],
  ["major", /\b(major|majors|intended|wants to study|planning to study|field of study)\b/],
  ["class_year", /\b(class of|grad year|graduation year|graduate|graduates|what grade|which grade|what year)\b/],
  ["school", /\b(high school|what school|which school)\b/],
  ["deadline", /\b(deadlines?|due|coming up|upcoming)\b/],
];

/**
 * Words that turn a lookup into a judgement, a comparison or a hypothetical.
 * Any of them keeps a question away from the direct-answer path: "what's her
 * GPA" is a lookup, "is her GPA good enough for Cornell" is not.
 */
export const JUDGEMENT_WORDS =
  /\b(need|needs|needed|should|enough|good|bad|strong|weak|compare|comparison|compared|versus|vs|improve|raise|boost|chance|chances|odds|likely|likelihood|why|explain|recommend|if|would|could|predict|estimate|better|worse|above|below|competitive|realistic|fit|fits|worth|instead|whether|trend|changed|history|over time|since|safe|risky|mean|means)\b/;

/** Question words that open a lookup. */
export const LOOKUP_LEAD = /^(what|whats|what is|what are|when|whens|which|who|how many|how much|tell me|show me|show|give me|list|remind me what|pull up)\b/;

/** Counselor shorthand, expanded before a document or email search so "ED" also finds "early decision". */
export const JARGON: Readonly<Record<string, string>> = {
  ed: "early decision", ed2: "early decision II", edii: "early decision II", ea: "early action",
  rea: "restrictive early action", scea: "single-choice early action", rd: "regular decision",
  css: "CSS Profile", fafsa: "FAFSA", sai: "student aid index", efc: "expected family contribution",
  coa: "cost of attendance", npc: "net price calculator",
  lor: "letter of recommendation", lors: "letters of recommendation", rec: "recommendation letter", recs: "recommendation letters",
  ap: "Advanced Placement", ib: "International Baccalaureate", uw: "unweighted", cds: "Common Data Set",
  ps: "personal statement", supp: "supplemental essay", supps: "supplemental essays",
  loci: "letter of continued interest", qb: "QuestBridge", nmsf: "National Merit Semifinalist",
};

/** Words that start a sentence or sit in a sentence often enough that a student or school with that name needs more than the bare word. */
export const COMMON_WORDS = new Set(
  (
    "will may june april august grace hope faith joy mark bill art rose jean page summer autumn dawn rich ray chase " +
    "max sky river reed bard brown rice duke union wells smith mercy regis trinity providence grove mount saint state " +
    "tech drew berry carroll heritage liberty pacific central northern southern eastern western national american " +
    "christian columbia concordia bethel calvin harding hollins lincoln washington franklin jefferson madison " +
    "wesley hamilton"
  ).split(" ")
);

export const STATE_NAMES = new Set(
  (
    "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois " +
    "indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri " +
    "montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee texas utah vermont virginia washington " +
    "wisconsin wyoming"
  ).split(" ")
);

export const MULTIWORD_PLACES = new Set([
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "rhode island",
  "south carolina", "south dakota", "west virginia", "district of columbia", "los angeles", "san francisco",
  "san diego", "new orleans", "st louis", "saint louis", "las vegas", "salt lake city", "new england",
]);

/**
 * Well-known abbreviations, each pointing at catalog names (search_name form,
 * tried in order). Resolved against the loaded catalog, so an abbreviation
 * whose school isn't in it simply isn't indexed.
 */
export const COLLEGE_ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
  mit: ["massachusetts institute of technology"],
  caltech: ["california institute of technology"],
  ucla: ["university of california los angeles"],
  "uc berkeley": ["university of california berkeley"],
  berkeley: ["university of california berkeley"],
  ucsd: ["university of california san diego"],
  "uc san diego": ["university of california san diego"],
  ucsb: ["university of california santa barbara"],
  uci: ["university of california irvine"],
  "uc irvine": ["university of california irvine"],
  "uc davis": ["university of california davis"],
  usc: ["university of southern california"],
  nyu: ["new york university"],
  upenn: ["university of pennsylvania"],
  penn: ["university of pennsylvania"],
  cmu: ["carnegie mellon university"],
  jhu: ["johns hopkins university"],
  hopkins: ["johns hopkins university"],
  washu: ["washington university in st louis"],
  wustl: ["washington university in st louis"],
  uchicago: ["university of chicago"],
  umich: ["university of michigan ann arbor"],
  "u of m": ["university of michigan ann arbor"],
  uva: ["university of virginia main campus", "university of virginia"],
  unc: ["university of north carolina at chapel hill"],
  "unc chapel hill": ["university of north carolina at chapel hill"],
  uiuc: ["university of illinois urbana champaign"],
  "ut austin": ["the university of texas at austin"],
  "georgia tech": ["georgia institute of technology main campus", "georgia institute of technology"],
  "penn state": ["pennsylvania state university main campus", "the pennsylvania state university"],
  bu: ["boston university"],
  bc: ["boston college"],
  uconn: ["university of connecticut"],
  "umass amherst": ["university of massachusetts amherst"],
  rpi: ["rensselaer polytechnic institute"],
  wpi: ["worcester polytechnic institute"],
  rit: ["rochester institute of technology"],
  gwu: ["george washington university"],
  byu: ["brigham young university"],
  uf: ["university of florida"],
  fsu: ["florida state university"],
  "notre dame": ["university of notre dame"],
  "william and mary": ["william and mary", "college of william and mary"],
};
