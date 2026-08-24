#!/usr/bin/env node
/**
 * Create the initial admin owner account.
 *
 * Usage:
 *   node scripts/create-admin-user.mjs
 *
 * Environment variables required:
 *   DATABASE_URL   — PostgreSQL connection string
 *   ADMIN_EMAIL    — email for the new owner (default: admin@urbont.com)
 *   ADMIN_NAME     — display name (default: Admin)
 *   ADMIN_PASSWORD — password (min 8 chars, REQUIRED)
 *   ADMIN_ROLE     — role (default: owner)
 */

import pg from 'pg';
import { scrypt, randomBytes } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const email    = process.env.ADMIN_EMAIL    || 'admin@urbont.com';
const name     = process.env.ADMIN_NAME     || 'Admin';
const password = process.env.ADMIN_PASSWORD;
const role     = process.env.ADMIN_ROLE     || 'owner';

if (!password) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is required.');
  console.error('Example: ADMIN_PASSWORD=MySecurePass123 node scripts/create-admin-user.mjs');
  process.exit(1);
}

if (password.length < 8) {
  console.error('ERROR: ADMIN_PASSWORD must be at least 8 characters.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO admin_users (email, name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, active = true
     RETURNING id, email, name, role`,
    [email.toLowerCase().trim(), name.trim(), role, hash]
  );
  const user = rows[0];
  console.log('\n✅ Admin user ready:');
  console.log(`   ID:    ${user.id}`);
  console.log(`   Email: ${user.email}`);
  console.log(`   Name:  ${user.name}`);
  console.log(`   Role:  ${user.role}`);
  console.log('\nYou can now sign in at panel.urbont.com\n');
} catch (err) {
  if (err.message?.includes('does not exist')) {
    console.error('ERROR: Table admin_users does not exist. Start the server once to run migrations first.');
  } else {
    console.error('ERROR:', err.message);
  }
  process.exit(1);
} finally {
  await pool.end();
}
