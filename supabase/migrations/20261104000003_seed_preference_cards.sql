-- The preference card deck: the 26 situation cards the student's card sort reads.
--
-- 20260918000001 created public.preference_cards but never put a card in it, so
-- every student's card sort read "No cards in the deck" (QA 2026-11-03). These are
-- the demo's 26 cards (meridies-demo lib/preferenceCards.ts), keyed by the demo id
-- without its "p-" prefix. card_key is unique, so this inserts only cards that
-- aren't there and never rewrites one someone corrected by hand; re-running it
-- changes nothing.
--
-- Deploy order: either. The routes already read the table; before this the deck
-- is empty and the sort says so. No new table, so no RLS or approval gate to
-- attach (preference_cards keeps its own). Not in REQUIRED_SCHEMA.

insert into public.preference_cards
  (card_key, category, category_label, prompt, counselor_note, example, sort_order)
values
  ('food-weekend', 'campus-life-and-food', 'Campus life & food', 'The dining halls close at the weekend. You feed yourself Saturday and Sunday.', 'A genuine operating reality at several small, well-regarded schools, and one families never ask about until the first October phone call home.', 'Caltech has no weekend dining-hall service', 1),
  ('food-plan', 'campus-life-and-food', 'Campus life & food', 'A mandatory meal plan for all four years, whether or not you cook.', 'Reads as a lifestyle question and lands as a money one: a required plan can add $6-8k a year that the sticker price already assumed.', null, 2),
  ('housing', 'campus-life-and-food', 'Campus life & food', 'Housing is guaranteed for one year only. After that you find an apartment in the city.', 'Separates students who want a campus from students who want a city, and flags the schools where the real cost of attendance starts in year two.', null, 3),
  ('greek', 'campus-life-and-food', 'Campus life & food', 'Most of the social life runs through fraternities and sororities.', 'A strong reaction either way is one of the most predictive signals in the deck for whether a student stays.', null, 4),
  ('dry', 'campus-life-and-food', 'Campus life & food', 'A dry campus, and the nearest town closes at nine.', 'Often correlated with the small rural schools that give the best merit aid.', null, 5),
  ('winter', 'location-and-seasons', 'Location & seasons', 'Five months of winter. It is dark by four in the afternoon from November.', 'Seasonal fit is the quietest cause of transfer applications from students who visited in April.', null, 1),
  ('humid', 'location-and-seasons', 'Location & seasons', 'Humid heat into October, and hurricane season is part of the academic calendar.', 'Worth asking before a Gulf Coast list gets built.', null, 2),
  ('rural', 'location-and-seasons', 'Location & seasons', 'The nearest city is two hours away and you will not have a car.', 'The honest version of ''beautiful rural campus''. Pairs with the guaranteed-housing card.', null, 3),
  ('flight', 'location-and-seasons', 'Location & seasons', 'Getting home means a connecting flight. You will manage two trips a year, not five.', 'Distance-from-home is usually asked in miles; asked as trips per year it gets a truthful answer: and it is a real line in the family''s budget.', null, 4),
  ('merit-band', 'financial-outlook', 'Financial outlook', 'The school gives you $15,000 and expects your family to find the remaining $70,000 each year.', 'The discount game, stated plainly. A family that reacts well to this needs the income-band generosity conversation before the list is finalized, not after the award letter.', null, 1),
  ('loans', 'financial-outlook', 'Financial outlook', 'You graduate with loans of about a year''s starting salary in your field.', 'Framing debt against the field''s own starting salary gets a more considered answer than a dollar figure does.', null, 2),
  ('fiscal', 'financial-outlook', 'Financial outlook', 'The school has closed programs in the last three years and its endowment per student is falling.', 'Fiscal health is a real admissions variable now. A student who shrugs at this needs the major-durability data in front of them.', null, 3),
  ('no-merit', 'financial-outlook', 'Financial outlook', 'No merit scholarships at all: aid is purely need-based, however strong your application.', 'True of the Ivies and most of the top no-merit schools. Sorts the students chasing a discount from the students chasing a name.', null, 4),
  ('work-study', 'financial-outlook', 'Financial outlook', 'Ten hours a week of campus work is part of how the package adds up.', 'Work study is presented as aid and spends like a job. Better to find the reaction now.', null, 5),
  ('premajor', 'academics-and-teaching', 'Academics & teaching', 'You are admitted to the school, not the major. You compete again in second year for the program you came for.', 'The pre-major model. A student who hates this should not have four of them on the list.', null, 1),
  ('large-lecture', 'academics-and-teaching', 'Academics & teaching', 'First-year lectures of four hundred, taught by a graduate student in section.', 'Pairs with the grad-to-undergrad ratio on the college profile.', null, 2),
  ('core', 'academics-and-teaching', 'Academics & teaching', 'A fixed core curriculum: two years of set texts before you choose anything.', 'Strong reactions here separate open-curriculum schools from core schools cleanly.', null, 3),
  ('research', 'academics-and-teaching', 'Academics & teaching', 'Undergraduate research from first year, but you have to go and ask for it.', 'Tests initiative as much as preference, and the answer tends to predict how a student will use a large university.', null, 4),
  ('size-large', 'social-and-size', 'Social & size', 'Forty thousand students. You will not see the same face twice in a week.', 'Size preference stated as an experience rather than a number.', null, 1),
  ('size-small', 'social-and-size', 'Social & size', 'Twelve hundred students. Everyone knows who you went out with last weekend.', 'The small-college trade-off that brochures never print.', null, 2),
  ('sports', 'social-and-size', 'Social & size', 'Saturdays in the fall belong to the football team, whether or not you go.', 'Big-state-school culture. Cheap to ask, expensive to discover in September.', null, 3),
  ('preprofessional', 'social-and-size', 'Social & size', 'Recruiting starts in first year and everyone around you is talking about internships.', 'Pre-professional intensity is a fit question, not a quality one: and a poor fit here reads as burnout by second year.', null, 4),
  ('uk-prereq', 'studying-outside-the-us', 'Studying outside the US', 'You must have finished AP Calculus BC with a 5 before your final year, or the application is not considered.', 'Major-specific prerequisites outside the US are hard requirements with no appeal, and they bind the course plan two years before the application. This card exists to surface the conflict while the schedule can still change.', 'Common for engineering and economics at UK universities', 1),
  ('uk-single', 'studying-outside-the-us', 'Studying outside the US', 'You apply to one subject and study only that subject for three years. No switching.', 'The single biggest structural difference between US and UK degrees, and the one students underestimate.', null, 2),
  ('abroad-aid', 'studying-outside-the-us', 'Studying outside the US', 'No need-based aid for international students. The published fee is what your family pays.', 'True of most non-US systems for US applicants; sometimes still cheaper than a US private, which is the conversation this card opens.', null, 3),
  ('abroad-visa', 'studying-outside-the-us', 'Studying outside the US', 'Working after you graduate depends on a visa the government can change while you study.', 'Worth an explicit reaction before a list tilts international.', null, 4)
on conflict (card_key) do nothing;
