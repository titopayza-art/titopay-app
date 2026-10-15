// Ticket kinds an organiser can sell, and the age groups an event can be
// aimed at. For a kind, 'check' is what the gate is told to look at and
// 'admits' is the usual number of people one ticket lets in.
const TICKET_KINDS = {
  general: { label: "General admission" }, early_bird: { label: "Early bird" }, vip: { label: "VIP" }, vvip: { label: "VVIP" },
  golden_circle: { label: "Golden circle" }, seated: { label: "Reserved seating" }, standing: { label: "Standing" },
  student: { label: "Student", check: "Check student card" }, child: { label: "Child", check: "Check age" },
  pensioner: { label: "Pensioner", check: "Check ID" }, couple: { label: "Couple", admits: 2 },
  group: { label: "Group", admits: 4 }, table: { label: "Table / booth", admits: 8 },
  day_pass: { label: "Day pass" }, multi_day: { label: "Weekend / multi-day pass" }, season: { label: "Season pass" },
  backstage: { label: "Backstage / meet & greet" }, hospitality: { label: "Hospitality" },
  accessible: { label: "Accessible", check: "Companion may enter with this ticket" }, late_entry: { label: "Late entry" },
};

const AGE_GROUPS = { all: "All ages", kids: "Kids (under 13)", teens: "Teens (13 to 17)", "18_24": "18 to 24", "25_34": "25 to 34",
  "35_49": "35 to 49", "50_plus": "50 and over", families: "Families" };

// What the scanner shows under the name: "VIP · Admit 2 · Check ID".
function gateLabel(tt) {
  const k = TICKET_KINDS[tt.kind || "general"] || {};
  const parts = [tt.name];
  if ((tt.admits || 1) > 1) parts.push(`Admit ${tt.admits}`);
  if (k.check) parts.push(k.check);
  return parts.join(" · ");
}

module.exports = { TICKET_KINDS, AGE_GROUPS, gateLabel };
