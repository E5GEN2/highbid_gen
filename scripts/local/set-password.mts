/**
 * Set (or reset) a password on an EXISTING user account — the owner-gated
 * bootstrap for migrating a Google account onto email/password. You type your
 * own password (hidden); it is scrypt-hashed and written to users.password_hash.
 * Never inserts a new user; the email must already exist.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/local/set-password.mts <email>
 *     [--local]   target hbgen_local instead of the .env.local DATABASE_URL (prod)
 *
 * Run from the repo root.
 */
import { readFileSync } from 'fs';
import path from 'path';
import readline from 'readline';
import pg from 'pg';
import { hashPassword } from '../../lib/password';

const repoRoot = process.cwd();
for (const l of readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) {
  const i = l.indexOf('='); if (i < 0) continue;
  const k = l.slice(0, i).trim(); let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (k && process.env[k] === undefined) process.env[k] = v;
}

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const email = argv.find(a => !a.startsWith('--'))?.trim().toLowerCase();
if (!email) { console.error('usage: set-password.mts <email> [--local]'); process.exit(1); }

const connectionString = local ? 'postgresql://localhost:5432/hbgen_local' : process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString, ssl: false });

const isTTY = Boolean(process.stdin.isTTY);

// Interactive hidden prompt (TTY only). Created on demand so we don't open
// stdin before it's needed. Echo is muted so the password isn't shown.
function hiddenPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muting = false;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (!muting) { process.stdout.write(s); return; }
    if (s.includes(question) || s === '\n' || s === '\r\n') process.stdout.write(s);
  };
  muting = true;
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); process.stdout.write('\n'); resolve(ans); });
  });
}

// Non-interactive: consume piped stdin and take the first line as the password.
async function readPipedLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

const target = local ? 'LOCAL hbgen_local' : `PROD (${(connectionString ?? '').split('@')[1] ?? '?'})`;

const found = await pool.query(
  `SELECT id, email, name, (google_id IS NOT NULL) AS has_google, (password_hash IS NOT NULL) AS has_password
     FROM users WHERE LOWER(email) = $1`, [email]);
if (found.rows.length === 0) {
  console.error(`\n✗ No account with email "${email}" on ${target}. (Sign up instead, or check the address.)`);
  await pool.end(); process.exit(1);
}
const u = found.rows[0];
console.log(`\nTarget: ${target}`);
console.log(`Account: ${u.email}  (google-linked: ${u.has_google}, has password already: ${u.has_password})`);

let pw: string;
if (isTTY) {
  pw = await hiddenPrompt('\nNew password (min 8 chars, hidden): ');
  const pw2 = await hiddenPrompt('Confirm password (hidden): ');
  if (pw !== pw2) { console.error('✗ Passwords do not match.'); await pool.end(); process.exit(1); }
} else {
  pw = await readPipedLine();
}
if (pw.length < 8) { console.error('✗ Password must be at least 8 characters.'); await pool.end(); process.exit(1); }

const hash = await hashPassword(pw);
const res = await pool.query(
  `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE LOWER(email) = $2`, [hash, email]);
console.log(res.rowCount === 1
  ? `\n✓ Password set for ${u.email}. You can now log in at /login with this email + password.`
  : `\n✗ Update affected ${res.rowCount} rows — nothing changed.`);
await pool.end();
