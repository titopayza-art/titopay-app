// A minimal SMTP sink, so the delivery path can be tested end to end without
// anything leaving the machine.
//
// It speaks just enough of the protocol for nodemailer to hand over a message,
// and writes each one to fake-smtp-inbox.json. The point is to read the headers
// the API actually sent — Reply-To in particular, which is set per message and
// cannot be verified by looking at the queue row.
const net = require("net");
const fs = require("fs");
const INBOX = `${__dirname}/fake-smtp-inbox.json`;
fs.writeFileSync(INBOX, "[]");

net.createServer((socket) => {
  let buffer = "";
  let inData = false;
  let message = "";
  socket.write("220 fake.titopay.local ESMTP\r\n");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\r\n");
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
          inbox.push(message);
          fs.writeFileSync(INBOX, JSON.stringify(inbox));
          message = "";
          socket.write("250 2.0.0 Ok: queued\r\n");
        } else {
          message += line + "\n";
        }
        continue;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === "EHLO" || verb === "HELO") socket.write("250-fake.titopay.local\r\n250 8BITMIME\r\n");
      else if (verb === "MAIL" || verb === "RCPT") socket.write("250 2.1.0 Ok\r\n");
      else if (verb === "DATA") { inData = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
      else if (verb === "QUIT") { socket.write("221 2.0.0 Bye\r\n"); socket.end(); }
      else socket.write("250 2.0.0 Ok\r\n");
    }
  });
  socket.on("error", () => {});
}).listen(2525, "127.0.0.1", () => console.log("fake SMTP on 2525"));
