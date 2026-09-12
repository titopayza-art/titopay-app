"use strict";

// WHAT A BUSINESS DOES, AND WHERE ITS MONEY COMES FROM.
//
// Two reference lists, and they are deliberately TitoPay's own rather than a
// bank's. A generic list built for corporate onboarding opens with "Business
// And Administrative" and "Energy, Water, Air And Waste", which is useless to a
// spaza shop, a hairdresser or a bakkie owner doing deliveries, and a customer
// who cannot find themselves picks whatever is nearest and the data is worth
// nothing. These read like the businesses that actually use TitoPay.
//
// WHY TITOPAY ASKS AT ALL, stated plainly because it is worth being honest
// about: a business telling us it sells food and is paid by its customers is
// ordinary, and a business telling us it is funded by loans and disposes of
// assets is a different risk picture. It also lets TitoPay build the right
// products: a list dominated by informal retail is a different roadmap from one
// dominated by professional services.
//
// WHAT IT IS NOT: it is not verification. A business selects these itself, they
// are self-declared, and nothing here is evidence of anything. The KYB status
// on `business_profiles` is a separate axis and this does not touch it.
//
// Keys are stable and stored; labels are display text and may be reworded. A
// key is never reused for a different meaning, because a stored row would
// silently change what it says.

const INDUSTRIES = Object.freeze([
  { key: "retail_general", label: "Retail and general dealer", hint: "Spaza, tuck shop, general dealer, corner shop" },
  { key: "food_drink", label: "Food and drink", hint: "Restaurant, takeaway, catering, bakery, shisanyama" },
  { key: "groceries_produce", label: "Groceries and fresh produce", hint: "Fruit and veg, butchery, farm stall" },
  { key: "transport_logistics", label: "Transport and logistics", hint: "Taxi, delivery, courier, removals, bakkie hire" },
  { key: "beauty_personal_care", label: "Beauty and personal care", hint: "Salon, barber, nails, spa" },
  { key: "health_wellness", label: "Health and wellness", hint: "Clinic, pharmacy, gym, traditional health" },
  { key: "clothing_footwear", label: "Clothing and footwear", hint: "Boutique, tailoring, sneakers, uniforms" },
  { key: "electronics_airtime", label: "Electronics, airtime and mobile", hint: "Phone shop, repairs, airtime and data" },
  { key: "construction_trades", label: "Construction and trades", hint: "Builder, plumber, electrician, painter, welder" },
  { key: "motor_automotive", label: "Motor and automotive", hint: "Mechanic, panel beater, car wash, spares, tyres" },
  { key: "professional_services", label: "Professional services", hint: "Accounting, legal, consulting, bookkeeping" },
  { key: "education_training", label: "Education and training", hint: "Creche, tutoring, driving school, skills training" },
  { key: "events_entertainment", label: "Events and entertainment", hint: "Events, DJ, hire, photography, venue" },
  { key: "accommodation_tourism", label: "Accommodation and tourism", hint: "Guest house, B&B, lodge, tours" },
  { key: "agriculture", label: "Agriculture and farming", hint: "Crops, livestock, poultry, fishing" },
  { key: "manufacturing", label: "Manufacturing and production", hint: "Workshop, factory, craft production" },
  { key: "wholesale_distribution", label: "Wholesale and distribution", hint: "Bulk supply, reselling, distribution" },
  { key: "cleaning_domestic", label: "Cleaning and domestic services", hint: "Cleaning, laundry, garden services" },
  { key: "security_services", label: "Security services", hint: "Guarding, alarms, CCTV" },
  { key: "media_design_marketing", label: "Media, design and marketing", hint: "Design, printing, advertising, content" },
  { key: "technology_it", label: "Technology and IT", hint: "Software, IT support, web, networks" },
  { key: "funeral_services", label: "Funeral services", hint: "Funeral parlour, burial society, memorials" },
  { key: "financial_services", label: "Financial and money services", hint: "Lending, insurance broking, money transfer" },
  { key: "property_rental", label: "Property and rental", hint: "Letting, property management, equipment hire" },
  { key: "community_nonprofit", label: "Community and non-profit", hint: "NPO, church, stokvel, association, club" },
  { key: "other", label: "Something else", hint: "Tell us in your own words" }
]);

// WHERE THE MONEY COMES IN FROM. A business may declare more than one, and one
// of them is primary, because "we mostly trade and occasionally get a grant" is
// a different picture from the reverse.
const SOURCES_OF_FUNDS = Object.freeze([
  { key: "trading_income", label: "Sales and trading income", hint: "Money customers pay you for goods or services" },
  { key: "professional_fees", label: "Professional or service fees", hint: "Fees for work done or advice given" },
  { key: "contract_tender", label: "Contract or tender income", hint: "Payments against a contract or awarded tender" },
  { key: "commission", label: "Commission", hint: "Earned on sales made for somebody else" },
  { key: "rental_income", label: "Rental income", hint: "Property, equipment or vehicle hire" },
  { key: "investment_income", label: "Investment income", hint: "Interest, dividends or returns" },
  { key: "owner_contribution", label: "Owner or member contributions", hint: "Money put in by owners, partners or members" },
  { key: "loan_financing", label: "Loan or financing", hint: "Bank loan, credit facility, or a funder" },
  { key: "grants_donations", label: "Grants or donations", hint: "Government, donor or public contributions" },
  { key: "asset_disposal", label: "Sale of assets", hint: "Selling equipment, vehicles or property" },
  { key: "other", label: "Something else", hint: "Tell us in your own words" }
]);

// A business may hold at most this many. Five is what the screens are built for
// and is more than enough to describe any real trading business; an unbounded
// list becomes a place to paste noise.
const MAX_SOURCES_OF_FUNDS = 5;

// "Something else" is the only key that may carry free text, and it is the only
// place a customer's own words are stored on this record.
const FREE_TEXT_KEY = "other";
const FREE_TEXT_MAX = 120;

const INDUSTRY_KEYS = Object.freeze(INDUSTRIES.map((item) => item.key));
const SOURCE_KEYS = Object.freeze(SOURCES_OF_FUNDS.map((item) => item.key));

function isIndustry(key) {
  return INDUSTRY_KEYS.includes(String(key || ""));
}
function isSourceOfFunds(key) {
  return SOURCE_KEYS.includes(String(key || ""));
}
function industryLabel(key) {
  return (INDUSTRIES.find((item) => item.key === key) || {}).label || null;
}
function sourceOfFundsLabel(key) {
  return (SOURCES_OF_FUNDS.find((item) => item.key === key) || {}).label || null;
}

module.exports = {
  INDUSTRIES,
  SOURCES_OF_FUNDS,
  INDUSTRY_KEYS,
  SOURCE_KEYS,
  MAX_SOURCES_OF_FUNDS,
  FREE_TEXT_KEY,
  FREE_TEXT_MAX,
  isIndustry,
  isSourceOfFunds,
  industryLabel,
  sourceOfFundsLabel
};
