"use strict";

// A SMALL IMAP CLIENT, WRITTEN RATHER THAN INSTALLED.
//
// This API carries fifteen dependencies and every one of them is a household
// name. The maintained IMAP libraries pull in eight more each - a logger, a
// SOCKS stack, charset tables - and this process signs payment instructions,
// so the bar for adding to that list is high. What is actually needed here is
// six commands against a mailbox we own, over TLS, and that is small enough to
// own outright. Nothing new to audit, nothing new to patch.
//
// The judgement rests on where the hostile input is. It is NOT here: this
// speaks to the operator's own mail server over an authenticated TLS session.
// The dangerous material is the message content, and that is never parsed by
// this file - it is handed to inbound-email-service as bytes, stored, and only
// then read. A bug in this file costs a failed poll, not a compromised parse.
//
// WHAT MAKES A MISTAKE HERE SURVIVABLE, which is the reason the subset is
// drawn where it is:
//
//   BODY.PEEK[] never sets \Seen.  The flag is set afterwards, by the caller,
//   and only once the message is safely stored. Crash anywhere in between and
//   the message is simply still unread next time. The failure mode of this
//   client is "fetch it again", never "lose it" - and fetching it again is
//   free, because inbound_emails has a unique index on Message-ID.
//
//   Sizes are read before bodies.  A mailbox will happily hand over a 40MB
//   message. Asking for RFC822.SIZE first means an oversized message is
//   identified without ever being pulled into memory.
//
//   Every read is capped and every command is on a timer.  A server that
//   stops talking mid-literal, or never stops talking, ends the connection
//   rather than the process.

const tls = require("tls");

const CRLF = "\r\n";

// Ceilings, not tuning knobs. They exist so a hostile or broken server cannot
// turn a poll into an outage.
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;  // whole-connection read ceiling
const MAX_LITERAL_BYTES = 8 * 1024 * 1024;    // one literal; larger is refused unread

class ImapError extends Error {
  constructor(message, code = "imap_error") {
    super(message);
    this.name = "ImapError";
    this.code = code;
  }
}

// COMMAND INJECTION, WHICH IN IMAP IS A NEWLINE.
//
// IMAP is a line protocol: a CR or LF inside a quoted string ends the command
// and begins another. A password containing one would let whatever set that
// password run arbitrary IMAP commands as the mailbox owner. Credentials are
// operator-supplied rather than public, but "only an admin can reach it" is
// how injection bugs are argued into existence, so the bytes that could do it
// are refused outright instead of escaped.
function quoted(value, field) {
  const text = String(value ?? "");
  if (/[\r\n\0]/.test(text)) {
    throw new ImapError(`${field} may not contain line breaks`, "invalid_value");
  }
  if (text.length > 512) throw new ImapError(`${field} is too long`, "invalid_value");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// A logical IMAP response line, which is not the same thing as a line of text.
// `* 12 FETCH (UID 34 BODY[] {5678}` is followed by exactly 5678 raw bytes and
// then the rest of the same logical line. Reading this as text would truncate
// at the first CRLF inside a message body, which is to say immediately.
function parseLogicalLine(buffer) {
  const parts = [];
  let text = "";
  let cursor = 0;

  for (;;) {
    const crlf = buffer.indexOf(CRLF, cursor, "utf8");
    if (crlf === -1) return null;  // incomplete; wait for more bytes

    const segment = buffer.toString("utf8", cursor, crlf);
    const literal = /\{(\d+)\}$/.exec(segment);

    if (!literal) {
      text += segment;
      parts.push({ type: "text", value: segment });
      return { parts, text, consumed: crlf + 2 };
    }

    const length = Number(literal[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LITERAL_BYTES) {
      throw new ImapError(`Refusing a ${literal[1]}-byte literal`, "literal_too_large");
    }
    const start = crlf + 2;
    const end = start + length;
    if (buffer.length < end) return null;  // literal not fully arrived

    text += segment;
    parts.push({ type: "text", value: segment });
    parts.push({ type: "literal", value: buffer.subarray(start, end) });
    cursor = end;
  }
}

class ImapConnection {
  constructor(socket, { timeoutMs }) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.totalRead = 0;
    this.tagCounter = 0;
    this.waiter = null;
    this.closed = false;
    this.fatal = null;

    socket.on("data", (chunk) => {
      this.totalRead += chunk.length;
      if (this.totalRead > MAX_RESPONSE_BYTES) {
        this.#fail(new ImapError("Server sent more than this client will read", "response_too_large"));
        return;
      }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.#drain();
    });
    socket.on("error", (error) => this.#fail(new ImapError(error.message, "socket_error")));
    socket.on("close", () => this.#fail(new ImapError("The mail server closed the connection", "closed")));
  }

  #fail(error) {
    this.closed = true;
    this.fatal = this.fatal || error;
    if (this.waiter) {
      const { reject, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      reject(this.fatal);
    }
  }

  #drain() {
    while (this.waiter) {
      let line;
      try {
        line = parseLogicalLine(this.buffer);
      } catch (error) {
        this.#fail(error);
        return;
      }
      if (!line) return;  // wait for more bytes
      this.buffer = this.buffer.subarray(line.consumed);
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve(line);
    }
  }

  #readLine() {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      // #fail is what rejects the waiter, so the waiter must still be there
      // when the timer fires. Clearing it first would leave this promise
      // pending forever and hang the poll instead of ending it.
      const timer = setTimeout(() => {
        this.#fail(new ImapError("The mail server stopped responding", "timeout"));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      this.#drain();
    });
  }

  // Sends one command and collects every untagged line until the tagged
  // completion, which is the only thing that says whether it worked.
  async #command(text, { logSafe = text } = {}) {
    if (this.closed) throw this.fatal || new ImapError("Connection is closed", "closed");
    const tag = `T${++this.tagCounter}`;
    // The ceiling is per command, not per connection: a long poll over many
    // messages is legitimate, one answer of unbounded size is not.
    this.totalRead = 0;
    this.socket.write(`${tag} ${text}${CRLF}`);

    const untagged = [];
    for (;;) {
      const line = await this.#readLine();
      if (line.text.startsWith(`${tag} `)) {
        const status = line.text.slice(tag.length + 1).trim();
        if (/^OK\b/i.test(status)) return { untagged, status };
        // The server's own words are the most useful diagnostic an operator
        // can get ("[AUTHENTICATIONFAILED]", "[ALERT] app password required"),
        // so they are passed through - with the command echoed in a form that
        // never contains the password.
        throw new ImapError(`${logSafe} failed: ${status}`, /^NO\b/i.test(status) ? "rejected" : "bad_command");
      }
      untagged.push(line);
    }
  }

  async greeting() {
    const line = await this.#readLine();
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(line.text)) {
      throw new ImapError(`Unexpected greeting: ${line.text.slice(0, 120)}`, "bad_greeting");
    }
    return line.text;
  }

  async login(user, password) {
    // The command is echoed in errors, so the echoed form carries no password.
    await this.#command(`LOGIN ${quoted(user, "username")} ${quoted(password, "password")}`,
      { logSafe: "LOGIN" });
  }

  async select(mailbox) {
    const { untagged } = await this.#command(`SELECT ${quoted(mailbox, "mailbox")}`);
    const exists = untagged.map((line) => /^\*\s+(\d+)\s+EXISTS\b/i.exec(line.text)).find(Boolean);
    return { exists: exists ? Number(exists[1]) : 0 };
  }

  // UIDs of messages nobody has read yet. UNSEEN rather than a date window
  // because \Seen is what this system uses to mean "ingested", and it is set
  // only after the message is stored.
  async searchUnseen() {
    const { untagged } = await this.#command("UID SEARCH UNSEEN");
    const found = untagged.map((line) => /^\*\s+SEARCH\b(.*)$/i.exec(line.text)).find(Boolean);
    if (!found) return [];
    return found[1].trim().split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number);
  }

  // Sizes before bodies, so an oversized message is skipped rather than read.
  async fetchSizes(uids) {
    if (!uids.length) return new Map();
    const { untagged } = await this.#command(`UID FETCH ${uids.join(",")} (UID RFC822.SIZE)`);
    const sizes = new Map();
    for (const line of untagged) {
      const uid = /\bUID\s+(\d+)/i.exec(line.text);
      const size = /\bRFC822\.SIZE\s+(\d+)/i.exec(line.text);
      if (uid && size) sizes.set(Number(uid[1]), Number(size[1]));
    }
    return sizes;
  }

  // PEEK, so reading a message does not mark it read. That single word is what
  // makes a crash mid-ingest harmless.
  async fetchMessage(uid) {
    const { untagged } = await this.#command(`UID FETCH ${Number(uid)} (BODY.PEEK[])`);
    for (const line of untagged) {
      if (!/\bFETCH\b/i.test(line.text)) continue;
      const literal = line.parts.find((part) => part.type === "literal");
      if (literal) return literal.value;
    }
    return null;
  }

  // Headers alone, for a message whose body is too large to accept. Without
  // this an oversized email is a silent disappearance; with it an operator at
  // least learns who wrote and about what.
  async fetchHeaders(uid) {
    const { untagged } = await this.#command(`UID FETCH ${Number(uid)} (BODY.PEEK[HEADER])`);
    for (const line of untagged) {
      if (!/\bFETCH\b/i.test(line.text)) continue;
      const literal = line.parts.find((part) => part.type === "literal");
      if (literal) return literal.value;
    }
    return null;
  }

  async markSeen(uid) {
    await this.#command(`UID STORE ${Number(uid)} +FLAGS (\\Seen)`);
  }

  async logout() {
    if (this.closed) return;
    await this.#command("LOGOUT").catch(() => null);
  }

  destroy() {
    this.closed = true;
    this.socket.destroy();
  }
}

// IMPLICIT TLS ONLY.
//
// Port 993 opens the TLS session before a single byte of the protocol, so
// there is no cleartext phase and no downgrade to negotiate away. STARTTLS on
// 143 begins in the clear and is stripped by an attacker on the path, and
// supporting it would mean writing the code that can be tricked into staying
// in the clear. It is simply not offered.
async function connectImap({ host, port = 993, user, password, timeoutMs = DEFAULT_TIMEOUT_MS,
  ca, servername } = {}) {
  if (!host) throw new ImapError("No mail server host configured", "not_configured");
  if (!user) throw new ImapError("No mailbox username configured", "not_configured");

  const socket = await new Promise((resolve, reject) => {
    const connection = tls.connect({
      host,
      port: Number(port) || 993,
      servername: servername || host,
      // Certificate verification is ALWAYS on and there is deliberately no
      // option to turn it off - not in settings, not here. A mailbox reachable
      // over an unverified TLS session is a mailbox someone can stand in front
      // of, and this one carries customers' support mail. `ca` adds a trusted
      // certificate (the test server presents one); it never subtracts a check.
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      minVersion: "TLSv1.2"
    });
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new ImapError(`No answer from ${host}:${port}`, "timeout"));
    }, timeoutMs);
    connection.once("secureConnect", () => { clearTimeout(timer); resolve(connection); });
    connection.once("error", (error) => { clearTimeout(timer); reject(new ImapError(error.message, "connect_failed")); });
  });

  socket.setTimeout(timeoutMs * 3);
  const connection = new ImapConnection(socket, { timeoutMs });
  try {
    await connection.greeting();
    await connection.login(user, password);
  } catch (error) {
    // A caller that never receives the connection cannot close it. Without
    // this, every rejected sign-in leaks an open TLS socket until the server
    // eventually times it out - and a mailbox with a stale password would leak
    // one on every poll, all day.
    connection.destroy();
    throw error;
  }
  return connection;
}

module.exports = {
  connectImap,
  ImapConnection,
  ImapError,
  // Exported for tests.
  parseLogicalLine,
  quoted,
  MAX_LITERAL_BYTES
};
