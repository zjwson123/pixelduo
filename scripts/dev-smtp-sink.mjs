// Minimal SMTP sink: accepts a real SMTP conversation from nodemailer and
// appends every received message (envelope + headers + body) to a file, so the
// PRODUCTION mail path (SMTP_URL → SmtpMailer → nodemailer) can be verified
// without an external provider account. No AUTH, no STARTTLS — nothing is
// advertised that would make a client try them.
//
//   node scripts/dev-smtp-sink.mjs [port] [outfile]
import net from "node:net";
import fs from "node:fs";

const PORT = Number(process.argv[2] ?? 2525);
const OUT = process.argv[3] ?? "/tmp/pd-smtp-inbox.log";

// Append without following a symlink. The default path is fixed, so a
// co-tenant on a shared host can pre-create it as a symlink and capture the
// live verification/reset links this sink receives — the class pass 61 closed
// for ci-local.sh/dev-restart.sh and lib/mail.ts's log-only mailer. O_NOFOLLOW
// makes the open fail with ELOOP instead.
//
// O_NOFOLLOW only covers the path ITSELF (pass 63): a pre-created regular file
// at the default /tmp path passed it, and mode 0600 applies only at creation,
// so a 0666 file from an earlier run kept receiving tokens readable by every
// local account. fstat proves the opened object is a single-link regular file
// owned by this user, then fchmod pins it 0600 before anything is written.
function appendOwnerOnly(text) {
  let fd;
  try {
    fd = fs.openSync(
      OUT,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const st = fs.fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!st.isFile() || st.nlink !== 1 || (uid !== null && st.uid !== uid)) {
      throw new Error("not a single-link regular file owned by this user");
    }
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
  } catch (e) {
    console.error(`[smtp-sink] refusing to write ${OUT}: ${e.code ?? e.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

net
  .createServer((sock) => {
    let inData = false;
    let buf = "";
    let message = "";
    let envelopeFrom = "";
    const envelopeTo = [];
    const say = (line) => sock.write(`${line}\r\n`);

    say("220 pd-sink ESMTP ready");

    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const nl = buf.indexOf("\r\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);

        if (inData) {
          if (line === ".") {
            appendOwnerOnly(
              [
                `--- received ${new Date().toISOString()}`,
                `envelope-from: ${envelopeFrom}`,
                `envelope-to:   ${envelopeTo.join(", ")}`,
                "",
                message,
                "===== END =====",
                "",
              ].join("\n"),
            );
            message = "";
            inData = false;
            say("250 2.0.0 Ok: queued as pd-sink");
          } else {
            // RFC 5321 dot-stuffing is undone on receipt.
            message += `${line.startsWith("..") ? line.slice(1) : line}\n`;
          }
          continue;
        }

        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) {
          say("250-pd-sink");
          say("250 8BITMIME");
        } else if (cmd.startsWith("HELO")) {
          say("250 pd-sink");
        } else if (cmd.startsWith("MAIL FROM")) {
          envelopeFrom = line;
          say("250 2.1.0 Ok");
        } else if (cmd.startsWith("RCPT TO")) {
          envelopeTo.push(line);
          say("250 2.1.5 Ok");
        } else if (cmd === "DATA") {
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "QUIT") {
          say("221 2.0.0 Bye");
          sock.end();
        } else {
          say("250 2.0.0 Ok");
        }
      }
    });
    sock.on("error", () => undefined);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`smtp sink listening on 127.0.0.1:${PORT} → ${OUT}`));

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
