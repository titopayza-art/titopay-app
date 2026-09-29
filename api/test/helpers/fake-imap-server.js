"use strict";

// A REAL IMAP SERVER, SMALL ENOUGH TO LIE TO.
//
// The point of testing against this rather than mocking the client is that the
// bugs worth catching live in the wire format - literals, folded responses,
// the tagged completion - and a mock of the client's own methods would assert
// nothing about any of them. This speaks actual IMAP over actual TLS, and can
// be told to misbehave in the specific ways a real server does on a bad day.
//
// It presents a self-signed certificate, which the client is given as a
// trusted CA. Verification is never disabled - the test trusts a certificate
// it generated rather than trusting everything.

const tls = require("tls");
const forge = require("node-forge");

const CRLF = "\r\n";

let cached = null;
function certificate(commonName = "imap.test.local") {
  if (cached) return cached;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: commonName }] }
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  cached = {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
    commonName
  };
  return cached;
}

// Messages are held as { uid, raw, seen }. `seen` is the assertion that
// matters most in these tests: it must only become true after the caller has
// stored the message.
function createFakeImap({ messages = [], onCommand = null, greeting = "* OK fake IMAP ready" } = {}) {
  const creds = certificate();
  const state = {
    messages: messages.map((message, index) => ({
      uid: message.uid ?? index + 1,
      raw: Buffer.isBuffer(message.raw) ? message.raw : Buffer.from(String(message.raw), "utf8"),
      seen: Boolean(message.seen)
    })),
    loginAttempts: [],
    commands: [],
    selected: null
  };

  const open = new Set();
  const server = tls.createServer({ key: creds.key, cert: creds.cert }, (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.write(`${greeting}${CRLF}`);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const at = buffer.indexOf(CRLF);
        if (at === -1) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        handle(socket, line);
      }
    });
    socket.on("error", () => {});
  });

  function handle(socket, line) {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) return;
    const [, tag, rest] = match;
    state.commands.push(rest);

    // A hook so a test can make the server behave badly for one command
    // without this file growing a mode for every failure.
    if (onCommand) {
      const override = onCommand(rest, { tag, socket, state });
      if (override === "handled") return;
    }

    const verb = rest.split(/\s+/)[0].toUpperCase();

    if (verb === "LOGIN") {
      // Captured verbatim so a test can prove exactly what went on the wire -
      // this is how the credential-injection test checks that a password with
      // a newline in it never became a second command.
      state.loginAttempts.push(rest);
      if (/BADPASS/.test(rest)) {
        return socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${CRLF}`);
      }
      return socket.write(`${tag} OK LOGIN completed${CRLF}`);
    }

    if (verb === "SELECT") {
      state.selected = rest.slice(verb.length).trim();
      socket.write(`* ${state.messages.length} EXISTS${CRLF}`);
      socket.write(`* 0 RECENT${CRLF}`);
      return socket.write(`${tag} OK [READ-WRITE] SELECT completed${CRLF}`);
    }

    if (/^UID\s+SEARCH\b/i.test(rest)) {
      const unseen = state.messages.filter((message) => !message.seen).map((message) => message.uid);
      socket.write(`* SEARCH${unseen.length ? ` ${unseen.join(" ")}` : ""}${CRLF}`);
      return socket.write(`${tag} OK UID SEARCH completed${CRLF}`);
    }

    if (/^UID\s+FETCH\b/i.test(rest)) {
      const set = /^UID\s+FETCH\s+(\S+)/i.exec(rest)[1];
      const uids = set.split(",").map(Number).filter(Boolean);
      const wantsBody = /BODY\.PEEK\[\]|BODY\[\]/i.test(rest);
      const wantsHeader = /BODY\.PEEK\[HEADER\]|BODY\[HEADER\]/i.test(rest);
      let sequence = 0;
      for (const uid of uids) {
        const message = state.messages.find((item) => item.uid === uid);
        if (!message) continue;
        sequence += 1;
        if (wantsHeader) {
          const header = message.raw.subarray(0, (() => {
            const at = message.raw.indexOf("\r\n\r\n");
            return at === -1 ? message.raw.length : at + 4;
          })());
          socket.write(`* ${sequence} FETCH (UID ${uid} BODY[HEADER] {${header.length}}${CRLF}`);
          socket.write(header);
          socket.write(`)${CRLF}`);
        } else if (wantsBody) {
          // The literal form, which is the whole reason this server exists.
          socket.write(`* ${sequence} FETCH (UID ${uid} BODY[] {${message.raw.length}}${CRLF}`);
          socket.write(message.raw);
          socket.write(`)${CRLF}`);
        } else {
          socket.write(`* ${sequence} FETCH (UID ${uid} RFC822.SIZE ${message.raw.length})${CRLF}`);
        }
      }
      return socket.write(`${tag} OK UID FETCH completed${CRLF}`);
    }

    if (/^UID\s+STORE\b/i.test(rest)) {
      const uid = Number(/^UID\s+STORE\s+(\d+)/i.exec(rest)?.[1]);
      const message = state.messages.find((item) => item.uid === uid);
      if (message && /\\Seen/i.test(rest)) message.seen = true;
      return socket.write(`${tag} OK UID STORE completed${CRLF}`);
    }

    if (verb === "LOGOUT") {
      socket.write(`* BYE fake IMAP signing off${CRLF}`);
      socket.write(`${tag} OK LOGOUT completed${CRLF}`);
      return socket.end();
    }

    socket.write(`${tag} BAD Unknown command${CRLF}`);
  }

  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      // Connect to the loopback address, but verify the certificate against
      // the name it was issued for. That is how a real client behaves, and it
      // keeps rejectUnauthorized meaningful in these tests.
      return {
        host: "127.0.0.1",
        servername: creds.commonName,
        port: server.address().port,
        ca: creds.cert
      };
    },
    async close() {
      // server.close() waits for live connections, so a test that deliberately
      // leaves one open would hang here rather than fail. Closing them first
      // keeps a leak a failed assertion instead of a stuck suite.
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createFakeImap, certificate, CRLF };
