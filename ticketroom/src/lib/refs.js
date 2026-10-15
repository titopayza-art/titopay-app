// Short IDs people can read out on the phone: EV-7K3M9Q for an event,
// ORG-4H8T2W for an organiser. Same alphabet as ticket codes (no 0/O, 1/I).
const { randomCode } = require("./crypto");

const PREFIX = { events: "EV-", organisers: "ORG-" };

async function newRef(q, table) {
  for (;;) {
    const ref = PREFIX[table] + randomCode(6);
    const { rows } = await q.query(`SELECT 1 FROM ${table} WHERE ref = $1`, [ref]);
    if (!rows[0]) return ref;
  }
}

module.exports = { newRef };
