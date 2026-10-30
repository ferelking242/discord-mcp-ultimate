#!/usr/bin/env node
/**
 * Prints a `DASHBOARD_PASSWORD_HASH` value for a password.
 *
 * Usage:  node scripts/hash-password.js
 *         node scripts/hash-password.js "my password"
 *
 * The password is read from the argument, or prompted for without echo. It is
 * never written to disk and never printed. Put the result in .env as
 * DASHBOARD_PASSWORD_HASH, which is preferred over DASHBOARD_PASSWORD: a leaked
 * environment file then does not hand over the password itself.
 */
const { randomBytes, scryptSync } = require("node:crypto");
const readline = require("node:readline");

const N = 16384;
const R = 8;
const P = 1;

function hash(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function prompt(question) {
  // Echo off, so the password does not land in the terminal's scrollback.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  return new Promise((resolve) => {
    let value = "";
    const onData = (char) => {
      const text = char.toString("utf8");
      if (text === "\n" || text === "\r" || text === "\u0004") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        process.stdout.write("\n");
        rl.close();
        resolve(value);
        return;
      }
      if (text === "\u0003") process.exit(130); // Ctrl-C
      if (text === "\u007f" || text === "\b") value = value.slice(0, -1);
      else value += text;
    };
    stdin.on("data", onData);
  });
}

(async () => {
  const fromArg = process.argv[2];
  if (fromArg && fromArg.length < 8) {
    console.error("Refusing a password shorter than 8 characters.");
    process.exit(1);
  }
  const password = fromArg ?? (await prompt("Password: "));
  if (password.length < 8) {
    console.error("Refusing a password shorter than 8 characters.");
    process.exit(1);
  }
  console.log("\nDASHBOARD_PASSWORD_HASH=" + hash(password));
})();
