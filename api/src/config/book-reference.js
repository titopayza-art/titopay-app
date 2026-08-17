"use strict";

// TITOPAY BOOK: THE VOCABULARY.
//
// What kind of business, what state a venue is in, what state a booking is in.
// Everything here is APPLICATION CONFIGURATION, not database constraint, and
// that is deliberate: adding a new vertical must be a deploy, not a migration.
// The same reasoning is written into business-profile-reference.js and into the
// banking foundation migration, and the database follows it - book_venues.category
// carries no CHECK constraint.
//
// Booking STATUS is the opposite case. It is TitoPay's own vocabulary, the thing
// every screen and every report keys off, so it IS constrained in the database,
// under a named constraint so it can be widened later without a table rewrite.

/* ------------------------------------------------------------ what it is */

// One booking engine, many shapes. A category does not change the engine; it
// changes the words on the screen and which resource model makes sense. A
// restaurant books a TABLE, a doctor books a ROOM with a PERSON, a gym books a
// SEAT in a class. All three are "a resource with capacity, for a span of time".
const CATEGORIES = Object.freeze([
  { key: "restaurant", label: "Restaurant", group: "Dining", resourceWord: "Table", bookingWord: "Reservation", hint: "Sit-down dining, bookings by table and party size" },
  { key: "cafe", label: "Cafe", group: "Dining", resourceWord: "Table", bookingWord: "Reservation", hint: "Coffee shop, bakery, casual dining" },
  { key: "bakery", label: "Bakery", group: "Dining", resourceWord: "Slot", bookingWord: "Order slot", hint: "Collection times and custom orders" },

  { key: "doctor", label: "Doctor", group: "Health", resourceWord: "Consulting room", bookingWord: "Appointment", hint: "General practice and specialists" },
  { key: "dentist", label: "Dentist", group: "Health", resourceWord: "Chair", bookingWord: "Appointment", hint: "Dental practice" },
  { key: "clinic", label: "Clinic", group: "Health", resourceWord: "Consulting room", bookingWord: "Appointment", hint: "Clinic, physiotherapy, optometry, other practices" },

  { key: "car_wash", label: "Car wash", group: "Automotive", resourceWord: "Bay", bookingWord: "Booking", hint: "Wash and valet, bookings by bay" },
  { key: "auto_detailing", label: "Detailing", group: "Automotive", resourceWord: "Bay", bookingWord: "Booking", hint: "Detailing and paint correction" },
  { key: "auto_service", label: "Auto service", group: "Automotive", resourceWord: "Bay", bookingWord: "Booking", hint: "Mechanic, tyres, panel beating" },

  { key: "salon", label: "Hair salon", group: "Beauty", resourceWord: "Stylist", bookingWord: "Appointment", hint: "Hair, braiding, treatments" },
  { key: "barber", label: "Barber", group: "Beauty", resourceWord: "Chair", bookingWord: "Appointment", hint: "Cuts, shaves, grooming" },
  { key: "spa", label: "Spa", group: "Beauty", resourceWord: "Therapist", bookingWord: "Appointment", hint: "Massage, treatments, wellness" },
  { key: "beauty_studio", label: "Beauty studio", group: "Beauty", resourceWord: "Therapist", bookingWord: "Appointment", hint: "Nails, lashes, skin, make-up" },

  { key: "gym", label: "Gym", group: "Fitness", resourceWord: "Class", bookingWord: "Booking", hint: "Gym floor and class bookings" },
  { key: "fitness_studio", label: "Fitness studio", group: "Fitness", resourceWord: "Class", bookingWord: "Booking", hint: "Yoga, pilates, spinning, boxing" },
  { key: "personal_training", label: "Personal training", group: "Fitness", resourceWord: "Trainer", bookingWord: "Session", hint: "One on one and small group" },

  { key: "hotel", label: "Hotel", group: "Hospitality", resourceWord: "Room", bookingWord: "Reservation", hint: "Rooms by night" },
  { key: "guesthouse", label: "Guest house", group: "Hospitality", resourceWord: "Room", bookingWord: "Reservation", hint: "Guest house, B&B, lodge" },

  { key: "experience", label: "Experience", group: "Experiences", resourceWord: "Group", bookingWord: "Booking", hint: "Tours, activities, adventures" },
  { key: "studio", label: "Studio", group: "Experiences", resourceWord: "Studio", bookingWord: "Booking", hint: "Photography, recording, rehearsal space" },

  { key: "other", label: "Something else", group: "Other", resourceWord: "Slot", bookingWord: "Booking", hint: "A general service booking" }
]);

// The categories where an exact, publicly pollable "3 slots left" figure is a
// patient-load signal rather than marketing. These default their public
// availability counter OFF; the business can still turn it on deliberately.
// Everyone else defaults ON, because for a restaurant it IS the marketing.
const PRIVATE_AVAILABILITY_CATEGORIES = Object.freeze(["doctor", "dentist", "clinic"]);

/* --------------------------------------------------------- what state it is in */

// A venue's own lifecycle. `draft` is the important one: a business must be able
// to save half a profile and come back, which section 11 of the brief requires
// explicitly, so nothing here forces a complete profile before saving.
const VENUE_STATUSES = Object.freeze(["draft", "published", "paused", "archived"]);

// A booking's lifecycle. These are the states the brief names in section 15,
// and they are the ones every list, filter, export and analytic keys off.
//
// The set is closed and constrained in the database because a typo here is a
// booking that no screen can find. It is a NAMED constraint so a later state
// (say `waitlisted`) is one ALTER away rather than a table rewrite.
const BOOKING_STATUSES = Object.freeze([
  "pending",     // requested, business has not answered yet
  "confirmed",   // the business said yes, or it was auto-confirmed
  "checked_in",  // the customer arrived
  "completed",   // the service happened
  "cancelled",   // called off by either side before it happened
  "rejected",    // the business declined the request
  "no_show"      // the customer did not arrive
]);

// The states that OCCUPY a resource. This is the single most important list in
// this file: it is what an availability check counts against, and what the
// overlap guard tests. A cancelled or completed booking must not hold a table.
const OCCUPYING_STATUSES = Object.freeze(["pending", "confirmed", "checked_in"]);

// The states a booking can still move OUT of. A completed booking is finished;
// re-opening one would let a business rewrite history after the money moved.
const TERMINAL_STATUSES = Object.freeze(["completed", "cancelled", "rejected", "no_show"]);

/* ------------------------------------------------------------- the money */

// Book's service codes, snake_case because that is pricing_rules' namespace
// (service_config is kebab-case; they are different namespaces and
// normalizeServiceCode converts between them).
//
// EVERY ONE OF THESE MUST EXIST IN pricing_rules BEFORE IT IS USED.
// transactions.service_code is a foreign key with ON DELETE RESTRICT, so a code
// with no rule does not fail gracefully - the whole payment INSERT is rejected.
// Worse, getPricingRule auto-creates a ZERO-FEE rule for anything it does not
// recognise, so a typo does not throw, it silently makes the thing free.
const SERVICE_CODES = Object.freeze({
  ACTIVATION: "book_business_activation"
});

// The documented default for the once-off activation. THIS IS NOT THE OPERATIVE
// PRICE. The operative price lives in pricing_rules so an operator can change it
// in the Pricing Engine; this is the seed value and the fallback, nothing else.
// Reading it directly instead of calling calculateFee would mean the console
// shows one price and the customer is charged another.
const ACTIVATION_DEFAULT_AMOUNT = 250.00;

/* ------------------------------------------------------------ lookups */

const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((item) => item.key));
const CATEGORY_GROUPS = Object.freeze([...new Set(CATEGORIES.map((item) => item.group))]);

function isCategory(key) {
  return CATEGORY_KEYS.includes(String(key || ""));
}
function category(key) {
  return CATEGORIES.find((item) => item.key === key) || null;
}
function categoryLabel(key) {
  return (category(key) || {}).label || null;
}
// What this kind of business calls the thing being booked, so a doctor's screen
// says "Appointment" and a restaurant's says "Reservation" without either of
// them being a separate booking engine.
function bookingWord(key) {
  return (category(key) || {}).bookingWord || "Booking";
}
function resourceWord(key) {
  return (category(key) || {}).resourceWord || "Slot";
}
function defaultShowsAvailabilityCount(key) {
  return !PRIVATE_AVAILABILITY_CATEGORIES.includes(String(key || ""));
}
function isBookingStatus(value) {
  return BOOKING_STATUSES.includes(String(value || ""));
}
function occupies(status) {
  return OCCUPYING_STATUSES.includes(String(status || ""));
}
function isTerminal(status) {
  return TERMINAL_STATUSES.includes(String(status || ""));
}

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  CATEGORY_GROUPS,
  PRIVATE_AVAILABILITY_CATEGORIES,
  VENUE_STATUSES,
  BOOKING_STATUSES,
  OCCUPYING_STATUSES,
  TERMINAL_STATUSES,
  SERVICE_CODES,
  ACTIVATION_DEFAULT_AMOUNT,
  isCategory,
  category,
  categoryLabel,
  bookingWord,
  resourceWord,
  defaultShowsAvailabilityCount,
  isBookingStatus,
  occupies,
  isTerminal
};
