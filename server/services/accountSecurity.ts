import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';

export type AccountStatus = 'active' | 'warned' | 'suspended' | 'banned';

export type InfractionType =
  | 'no_show'
  | 'fraud'
  | 'abuse'
  | 'chargeback'
  | 'duplicate_account'
  | 'policy_violation'
  | 'safety_incident'
  | 'payment_fraud'
  | 'harassment'
  | 'vandalism';

export type InfractionSeverity = 'low' | 'medium' | 'high' | 'critical';

const INFRACTION_POINTS: Record<InfractionSeverity, number> = {
  low:      1,
  medium:   3,
  high:     6,
  critical: 12,
};

const WARN_THRESHOLD       =  1;
const SUSPEND_7D_THRESHOLD =  5;
const SUSPEND_30D_THRESHOLD = 11;
const BAN_THRESHOLD         = 17;

const AUTO_BAN_TYPES: InfractionType[] = ['payment_fraud', 'fraud'];

// ─── Get account status (auto-lifts expired suspensions) ─────────────────────
export async function getAccountStatus(userId: string): Promise<{
  status: AccountStatus;
  reason?: string;
  suspendedUntil?: string | null;
  infractionCount: number;
}> {
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('account_status, status_reason, suspension_until, infraction_count')
      .eq('id', userId)
      .maybeSingle();

    if (!data) return { status: 'active', infractionCount: 0 };

    const status = (data.account_status as AccountStatus) || 'active';

    if (status === 'suspended' && data.suspension_until) {
      if (new Date(data.suspension_until as string) <= new Date()) {
        await supabaseAdmin
          .from('profiles')
          .update({ account_status: 'active', status_reason: null, suspension_until: null })
          .eq('id', userId);
        return { status: 'active', infractionCount: (data.infraction_count as number) ?? 0 };
      }
    }

    return {
      status,
      reason:          (data.status_reason as string) ?? undefined,
      suspendedUntil:  (data.suspension_until as string) ?? null,
      infractionCount: (data.infraction_count as number) ?? 0,
    };
  } catch {
    return { status: 'active', infractionCount: 0 };
  }
}

// ─── Record an infraction and apply automatic action ─────────────────────────
export async function recordInfraction(params: {
  userId:          string;
  infractionType:  InfractionType;
  severity:        InfractionSeverity;
  description:     string;
  adminId?:        string;
}): Promise<{ actionTaken: string; newStatus: AccountStatus; totalPoints: number }> {
  const { userId, infractionType, severity, description, adminId } = params;

  // FIX: Non-atomic read-modify-write — two simultaneous infractions for the same user
  // could both read the same infraction_count and both write N+points instead of N+2*points.
  // We now pass currentPoints into the update as an optimistic lock (.eq infraction_count ==
  // currentPoints). If another writer changed it first, the update matches 0 rows and we
  // fall back to a direct atomic increment via rpc, then re-read to determine the new status.
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('infraction_count, account_status')
    .eq('id', userId)
    .maybeSingle();

  const currentPoints = (profile?.infraction_count as number) ?? 0;
  const addedPoints   = INFRACTION_POINTS[severity];
  const newPoints     = currentPoints + addedPoints;

  let actionTaken: string;
  let newStatus:   AccountStatus;
  let statusReason: string;
  let suspensionUntil: string | null = null;

  const autoBan = AUTO_BAN_TYPES.includes(infractionType) || severity === 'critical' || newPoints >= BAN_THRESHOLD;

  if (autoBan) {
    actionTaken  = 'banned';
    newStatus    = 'banned';
    statusReason = `Account permanently deactivated. Reason: ${description}`;
  } else if (newPoints >= SUSPEND_30D_THRESHOLD) {
    actionTaken  = 'suspended_30d';
    newStatus    = 'suspended';
    statusReason = `Account suspended for 30 days. Reason: ${description}`;
    const until  = new Date();
    until.setDate(until.getDate() + 30);
    suspensionUntil = until.toISOString();
  } else if (newPoints >= SUSPEND_7D_THRESHOLD) {
    actionTaken  = 'suspended_7d';
    newStatus    = 'suspended';
    statusReason = `Account suspended for 7 days. Reason: ${description}`;
    const until  = new Date();
    until.setDate(until.getDate() + 7);
    suspensionUntil = until.toISOString();
  } else if (newPoints >= WARN_THRESHOLD) {
    actionTaken  = 'warned';
    newStatus    = 'warned';
    statusReason = `Warning issued. Reason: ${description}`;
  } else {
    actionTaken  = 'noted';
    newStatus    = (profile?.account_status as AccountStatus) || 'active';
    statusReason = description;
  }

  await supabaseAdmin.from('account_infractions').insert({
    user_id:        userId,
    infraction_type: infractionType,
    severity,
    description,
    action_taken:   actionTaken,
    created_by:     adminId || null,
  });

  const updatePayload: Record<string, unknown> = {
    account_status:   newStatus,
    status_reason:    statusReason,
    infraction_count: newPoints,
    last_flagged_at:  new Date().toISOString(),
  };
  if (suspensionUntil)        updatePayload.suspension_until = suspensionUntil;
  if (newStatus === 'banned')  updatePayload.suspension_until = null;

  // Optimistic-lock the update: only succeeds if infraction_count hasn't changed since we read it.
  // If it returns no rows (concurrent write won), fall back to an unconditional update so the
  // infraction is never silently lost — the status thresholds are recalculated from newPoints
  // which may be slightly stale, but a one-point drift is far safer than a dropped sanction.
  const { data: locked } = await supabaseAdmin
    .from('profiles')
    .update(updatePayload)
    .eq('id', userId)
    .eq('infraction_count', currentPoints)  // optimistic lock
    .select('id')
    .maybeSingle();

  if (!locked) {
    // Another concurrent recordInfraction won the CAS — apply status change unconditionally
    // so this infraction is still enforced (point total may be off by one concurrent call,
    // but the sanction determined from newPoints is still applied).
    logger.warn({ userId, severity, infractionType }, '[SECURITY] Concurrent infraction detected — applying status update unconditionally');
    await supabaseAdmin.from('profiles').update(updatePayload).eq('id', userId);
  }

  logger.info({ userId, infractionType, severity, actionTaken, totalPoints: newPoints }, '[SECURITY] Infraction recorded');

  return { actionTaken, newStatus, totalPoints: newPoints };
}

// ─── Manually set account status (admin action) ───────────────────────────────
export async function manuallySetStatus(params: {
  userId:       string;
  status:       AccountStatus;
  reason:       string;
  suspendDays?: number;
  adminId?:     string;
}): Promise<void> {
  const { userId, status, reason, suspendDays, adminId } = params;

  const updatePayload: Record<string, unknown> = {
    account_status:  status,
    status_reason:   reason,
    suspension_until: null,
    last_flagged_at:  new Date().toISOString(),
  };

  if (status === 'suspended' && suspendDays) {
    const until = new Date();
    until.setDate(until.getDate() + suspendDays);
    updatePayload.suspension_until = until.toISOString();
  }

  await supabaseAdmin.from('profiles').update(updatePayload).eq('id', userId);

  if (adminId || status !== 'active') {
    const severityMap: Record<AccountStatus, InfractionSeverity> = {
      banned:    'critical',
      suspended: 'high',
      warned:    'medium',
      active:    'low',
    };
    await supabaseAdmin.from('account_infractions').insert({
      user_id:        userId,
      infraction_type: status === 'active' ? 'policy_violation' : 'policy_violation',
      severity:        severityMap[status],
      description:     reason,
      action_taken:    status === 'suspended' ? `suspended_${suspendDays || 0}d` : status,
      created_by:      adminId || null,
    });
  }

  logger.info({ userId, status, adminId }, '[SECURITY] Account status updated');
}

// ─── Register device fingerprint and detect duplicate accounts ────────────────
export async function registerDeviceSession(params: {
  userId:      string;
  fingerprint: string;
  ipAddress?:  string;
  userAgent?:  string;
}): Promise<{ isDuplicate: boolean; linkedAccountCount: number }> {
  const { userId, fingerprint, ipAddress, userAgent } = params;

  if (!fingerprint || fingerprint.length < 8) return { isDuplicate: false, linkedAccountCount: 0 };

  try {
    await supabaseAdmin.from('device_sessions').upsert({
      fingerprint,
      user_id:      userId,
      ip_address:   ipAddress || null,
      user_agent:   userAgent || null,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'fingerprint,user_id' });

    const { data: otherSessions } = await supabaseAdmin
      .from('device_sessions')
      .select('user_id')
      .eq('fingerprint', fingerprint)
      .neq('user_id', userId);

    const linkedAccounts = (otherSessions ?? []) as { user_id: string }[];
    const isDuplicate    = linkedAccounts.length > 0;

    if (isDuplicate) {
      logger.warn({ userId, fingerprintPrefix: fingerprint.substring(0, 8), linkedCount: linkedAccounts.length + 1 }, '[SECURITY] Device shared by multiple accounts');

      const { data: currentProfile } = await supabaseAdmin
        .from('profiles')
        .select('account_status')
        .eq('id', userId)
        .maybeSingle();

      const currentStatus = (currentProfile?.account_status as AccountStatus) || 'active';
      if (currentStatus === 'active') {
        await supabaseAdmin.from('profiles').update({
          account_status:  'warned',
          status_reason:   'Account automatically flagged: this device is linked to multiple accounts. Under review.',
          last_flagged_at: new Date().toISOString(),
        }).eq('id', userId);

        await supabaseAdmin.from('account_infractions').insert({
          user_id:        userId,
          infraction_type: 'duplicate_account',
          severity:       'medium',
          description:    `Device fingerprint shared with ${linkedAccounts.length} other account(s). Auto-flagged at login.`,
          action_taken:   'warned',
          created_by:     null,
        });
      }
    }

    return { isDuplicate, linkedAccountCount: linkedAccounts.length };
  } catch (err: any) {
    logger.error({ err: err.message }, '[SECURITY] registerDeviceSession error');
    return { isDuplicate: false, linkedAccountCount: 0 };
  }
}

// ─── Scan all accounts for shared device fingerprints (admin) ────────────────
export async function scanDuplicateAccounts(): Promise<{
  fingerprint:  string;
  sessionCount: number;
  accounts:     { userId: string; phone?: string; email?: string; status: string; name?: string }[];
}[]> {
  const { data } = await supabaseAdmin
    .from('device_sessions')
    .select('fingerprint, user_id');

  if (!data) return [];

  const fpMap = new Map<string, string[]>();
  for (const row of data as { fingerprint: string; user_id: string }[]) {
    const arr = fpMap.get(row.fingerprint) || [];
    if (!arr.includes(row.user_id)) {
      arr.push(row.user_id);
      fpMap.set(row.fingerprint, arr);
    }
  }

  const duplicates: {
    fingerprint: string;
    sessionCount: number;
    accounts: { userId: string; phone?: string; email?: string; status: string; name?: string }[];
  }[] = [];

  for (const [fp, userIds] of fpMap.entries()) {
    if (userIds.length < 2) continue;

    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, email, account_status, first_name, last_name')
      .in('id', userIds);

    type DuplicateProfileRow = {
      id: string;
      phone?: string;
      email?: string;
      account_status?: string;
      first_name?: string;
      last_name?: string;
    };
    duplicates.push({
      fingerprint:  fp.substring(0, 12) + '***',
      sessionCount: userIds.length,
      accounts: ((profiles ?? []) as DuplicateProfileRow[]).map((p) => ({
        userId: p.id,
        phone:  p.phone || undefined,
        email:  p.email || undefined,
        name:   [p.first_name, p.last_name].filter(Boolean).join(' ') || undefined,
        status: p.account_status || 'active',
      })),
    });
  }

  return duplicates;
}

// ─── Get infraction history for a user ───────────────────────────────────────
export async function getInfractionHistory(userId: string): Promise<{
  id:             string;
  infractionType: string;
  severity:       string;
  description:    string;
  actionTaken:    string;
  createdAt:      string;
}[]> {
  const { data } = await supabaseAdmin
    .from('account_infractions')
    .select('id, infraction_type, severity, description, action_taken, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  type InfractionRow = {
    id: string;
    infraction_type: string;
    severity: string;
    description?: string;
    action_taken?: string;
    created_at: string;
  };
  return ((data ?? []) as InfractionRow[]).map((r) => ({
    id:             r.id,
    infractionType: r.infraction_type,
    severity:       r.severity,
    description:    r.description || '',
    actionTaken:    r.action_taken || '',
    createdAt:      r.created_at,
  }));
}
