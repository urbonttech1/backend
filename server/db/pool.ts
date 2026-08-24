import pg from 'pg';
import { logger } from '../lib/logger';
  import dns from 'dns';

  // Force IPv4 DNS resolution — Supabase DB hostnames sometimes resolve to IPv6
  // addresses (2600:1f16:...) that are unreachable in this runtime environment.
  dns.setDefaultResultOrder('ipv4first');

  const { Pool } = pg;

  // Direct Postgres pool to Supabase.
  // SUPABASE_DB_URL (or DATABASE_URL) must be set for full DB functionality.
  const rawConnectionString =
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    process.env.VITE_SUPABASE_DB_URL;

  /**
   * Auto-rewrite direct Supabase DB URLs to the Session Pooler (IPv4).
   * Direct hosts (db.{ref}.supabase.co) only have AAAA (IPv6) records and are
   * unreachable from servers without IPv6.  The Session Pooler has A (IPv4)
   * records and supports the full SQL feature set.
   *
   * Transforms:
   *   postgresql://postgres:[pw]@db.{ref}.supabase.co:5432/postgres
   *   → postgresql://postgres.{ref}:[pw]@aws-0-{region}.pooler.supabase.com:5432/postgres
   */
  function toPoolerUrl(url: string): string {
    const match = url.match(/\/\/(postgres):([^@]+)@db\.([a-z0-9]+)\.supabase\.co(:\d+)?\//);
    if (!match) return url; // already a pooler URL or unknown format — leave as-is
    const [, , password, ref] = match;
    const region = process.env.SUPABASE_REGION || 'us-west-2';
    const pooler = `aws-0-${region}.pooler.supabase.com`;
    return url
      .replace(`postgres:${password}@db.${ref}.supabase.co`, `postgres.${ref}:${password}@${pooler}`)
      .replace(/:\d+\/postgres/, ':5432/postgres'); // session pooler uses 5432
  }

  const connectionString = rawConnectionString ? toPoolerUrl(rawConnectionString) : undefined;

  if (!rawConnectionString) {
    logger.warn({}, '[DB] SUPABASE_DB_URL not set — direct database features (migrations, cron jobs) unavailable. Set in environment variables (Supabase → Settings → Database → Connection string URI).');
  } else if (connectionString !== rawConnectionString) {
    logger.info('[Pool] Direct Supabase host detected — switched to IPv4 pooler automatically.');
  } else {
    logger.info('[Pool] Database connection string found — connecting to Supabase Postgres.');
  }

  // Create a real pool if connection string is available, or a stub that fails gracefully on use.
  // Using a stub avoids a fatal module-scope crash that would prevent the HTTP server from starting.
  export const pool: pg.Pool = connectionString
    ? new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
        max: 5, // Cloud Run may run multiple containers; keep per-instance pool small to avoid exhausting Supabase connection limits
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      })
    : (() => {
        const err = () =>
          Promise.reject(
            new Error(
              '[DB] SUPABASE_DB_URL is not configured. ' +
              'Set it in Spaceship → Environment Variables. ' +
              'Value: Supabase → Settings → Database → Connection string (URI mode).'
            )
          );
        return {
          connect:    err,
          query:      err,
          end:        () => Promise.resolve(),
          on:         () => pool,
          off:        () => pool,
          removeAllListeners: () => pool,
          totalCount: 0,
          idleCount:  0,
          waitingCount: 0,
        } as unknown as pg.Pool;
      })();
  