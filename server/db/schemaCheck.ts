import { supabaseAdmin } from './client.js';
    import { logger } from '../lib/logger';

    const REQUIRED_TABLES = [
    // Core ride & user tables
    'profiles',
    'rides',
    'ride_logs',
    'ride_chats',
    'driver_documents',
    'driver_locations',
    'driver_stats',
    'driver_streaks',
    'driver_quest_progress',
    'driver_selfie_log',
    // Notifications & messaging
    'notifications',
    'user_push_tokens',
    'push_subscriptions',
    // Support & admin
    'support_tickets',
    'complaints',
    'incidents',
    'client_feedback',
    'feedback',
    'app_config',
    'admin_users',
    // Business features
    'promo_codes',
    'promo_code_uses',
    'corporate_accounts',
    'corporate_members',
    'urbont_subscriptions',
    'fare_splits',
    'fare_split_payments',
    'referrals',
    'gift_requests',
    // UX features
    'saved_places',
    'favorite_drivers',
    'preferred_drivers',
    'airport_queue',
    'account_infractions',
    'device_sessions',
    ] as const;

    export async function verifySupabaseSchema(): Promise<void> {
    const missing: string[] = [];
    const errors: { table: string; message: string }[] = [];

    await Promise.all(
      REQUIRED_TABLES.map(async (table) => {
        const { error } = await supabaseAdmin
          .from(table)
          .select('*', { head: true, count: 'exact' })
          .limit(1);

        if (error) {
          const msg = (error.message || '').toLowerCase();
          const code = (error as unknown as Record<string,unknown>).code;
          if (
            code === '42P01' ||
            msg.includes('does not exist') ||
            msg.includes('not found') ||
            msg.includes('schema cache')
          ) {
            missing.push(table);
          } else {
            errors.push({ table, message: error.message });
          }
        }
      }),
    );

    if (missing.length === 0 && errors.length === 0) {
      logger.info(`[Schema] OK — all ${REQUIRED_TABLES.length} required Supabase tables present.`);
      return;
    }

    logger.error('\n========================================================');
    logger.error('[Schema] ❌ Supabase schema check FAILED');
    if (missing.length > 0) {
      logger.error(`[Schema] Missing tables (${missing.length}): ${missing.join(', ')}`);
      logger.error('[Schema] Create them in Supabase before the app can serve traffic.');
    }
    if (errors.length > 0) {
      logger.error('[Schema] Tables with access errors:');
      for (const e of errors) {
        logger.error(`         - ${e.table}: ${e.message}`);
      }
    }
    logger.error('========================================================\n');
    }
    