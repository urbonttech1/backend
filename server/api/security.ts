import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAdmin, requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { notifyUser } from '../services/fcm';
import { createContextLogger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const log = createContextLogger('SECURITY');
import {
  getAccountStatus,
  recordInfraction,
  manuallySetStatus,
  registerDeviceSession,
  scanDuplicateAccounts,
  getInfractionHistory,
  type InfractionType,
  type InfractionSeverity,
  type AccountStatus,
} from '../services/accountSecurity';

export const securityRouter = Router();

// ─── Velocity checking ────────────────────────────────────────────────────────
const requestLog: Map<string, number[]> = new Map();
const VELOCITY_LIMIT  = 3;
const VELOCITY_WINDOW = 10000;

function checkVelocity(ip: string): boolean {
  const now        = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < VELOCITY_WINDOW);
  if (timestamps.length >= VELOCITY_LIMIT) return false;
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return true;
}

// ─── Audit log (in-memory chain + DB persistence) ────────────────────────────
interface AuditLog { id: string; timestamp: string; action: string; data: unknown; previousHash: string; hash: string; }
const auditChain: AuditLog[] = [];

async function logAuditEvent(action: string, data: unknown) {
  const prev      = auditChain[auditChain.length - 1];
  const prevHash  = prev ? prev.hash : 'GENESIS_BLOCK';
  const timestamp = new Date().toISOString();
  const payload   = JSON.stringify({ action, data, prevHash, timestamp });
  const hash      = crypto.createHash('sha256').update(payload).digest('hex');
  auditChain.push({ id: crypto.randomUUID(), timestamp, action, data, previousHash: prevHash, hash });
  log.info(`[AUDIT] ${action} | hash: ${hash.substring(0, 8)}...`);
  try {
    await supabaseAdmin.from('incidents').insert({
      incid_type: 'audit_event', reporter_role: 'admin', severity: 'low', incid_status: 'closed',
      description: JSON.stringify({ action, data, hash }), created_at: timestamp, updated_at: timestamp,
    });
  } catch { /* non-fatal */ }
}

// ─── Register device fingerprint (called after successful login) ──────────────
securityRouter.post('/register-device', requireSupabaseAuth, async (req: Request, res: Response) => {
  const userId               = req.supabaseUid!;
  const { fingerprint, userAgent } = req.body as { fingerprint?: string; userAgent?: string };
  const ipAddress            = req.ip || req.socket.remoteAddress || undefined;

  if (!fingerprint) return res.status(400).json({ error: 'fingerprint required' });

  const result = await registerDeviceSession({ userId, fingerprint, ipAddress, userAgent });
  return res.json({ success: true, ...result });
});

// ─── Check own account status (passengers) ───────────────────────────────────
securityRouter.get('/account-status', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const status = await getAccountStatus(req.supabaseUid!);
    return res.json(status);
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch account status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Passenger security management
// ─────────────────────────────────────────────────────────────────────────────

// List all passengers with status summary
securityRouter.get('/admin/passengers', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, phone, email, account_status, status_reason, suspension_until, infraction_count, total_rides, created_at, last_flagged_at')
      .eq('role', 'passenger')
      .order('last_flagged_at', { ascending: false, nullsFirst: false });

    if (error) throw error;
    type PassengerSecurityRow = {
      id: string;
      first_name?: string;
      last_name?: string;
      phone?: string;
      email?: string;
      account_status?: string;
      status_reason?: string;
      suspension_until?: string;
      infraction_count?: number;
      total_rides?: number;
      created_at?: string;
      last_flagged_at?: string;
    };
    return res.json(((data ?? []) as PassengerSecurityRow[]).map((p) => ({
      id:              p.id,
      name:            [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown',
      phone:           p.phone,
      email:           p.email,
      status:          p.account_status || 'active',
      statusReason:    p.status_reason,
      suspendedUntil:  p.suspension_until,
      infractionCount: p.infraction_count ?? 0,
      totalRides:      p.total_rides ?? 0,
      createdAt:       p.created_at,
      lastFlaggedAt:   p.last_flagged_at,
    })));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list passengers' });
  }
});

// Infraction history for a passenger
securityRouter.get('/admin/passengers/:userId/infractions', requireAdmin, async (req: Request, res: Response) => {
  try {
    const history = await getInfractionHistory(req.params.userId);
    const status  = await getAccountStatus(req.params.userId);
    return res.json({ status, infractions: history });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch infraction history' });
  }
});

// Record an infraction for a passenger
securityRouter.post('/admin/passengers/:userId/infraction', requireAdmin, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { infractionType, severity, description } = req.body as {
    infractionType: InfractionType;
    severity:       InfractionSeverity;
    description:    string;
  };

  const validTypes:      InfractionType[]      = ['no_show','fraud','abuse','chargeback','duplicate_account','policy_violation','safety_incident','payment_fraud','harassment','vandalism'];
  const validSeverities: InfractionSeverity[]  = ['low','medium','high','critical'];

  if (!infractionType || !severity || !description)   return res.status(400).json({ error: 'infractionType, severity, and description are required.' });
  if (!validTypes.includes(infractionType))            return res.status(400).json({ error: 'Invalid infraction type.' });
  if (!validSeverities.includes(severity))             return res.status(400).json({ error: 'Invalid severity.' });

  try {
    const result = await recordInfraction({ userId, infractionType, severity, description, adminId: req.supabaseUid });
    await logAuditEvent('PASSENGER_INFRACTION', { userId, infractionType, severity, action: result.actionTaken });
    return res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record infraction' });
  }
});

// Manually set account status (warn / suspend / ban / restore)
securityRouter.post('/admin/passengers/:userId/status', requireAdmin, async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { status, reason, suspendDays } = req.body as { status: AccountStatus; reason: string; suspendDays?: number };

  const validStatuses: AccountStatus[] = ['active','warned','suspended','banned'];
  if (!validStatuses.includes(status))                     return res.status(400).json({ error: 'Invalid status.' });
  if (!reason)                                             return res.status(400).json({ error: 'reason is required.' });
  if (status === 'suspended' && !(suspendDays && suspendDays > 0)) return res.status(400).json({ error: 'suspendDays required for suspension.' });

  try {
    await manuallySetStatus({ userId, status, reason, suspendDays, adminId: req.supabaseUid });
    await logAuditEvent('ACCOUNT_STATUS_CHANGE', { userId, status, reason, admin: req.supabaseUid });
    return res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update account status' });
  }
});

// Scan for duplicate accounts (shared device fingerprints)
securityRouter.get('/admin/duplicates', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const duplicates = await scanDuplicateAccounts();
    return res.json({ count: duplicates.length, duplicates });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to scan duplicates' });
  }
});

// Bulk-deactivate duplicates, keeping one primary account
securityRouter.post('/admin/deactivate-duplicates', requireAdmin, async (req: Request, res: Response) => {
  const { userIds, keepUserId, reason } = req.body as { userIds: string[]; keepUserId: string; reason: string };

  if (!Array.isArray(userIds) || !reason) return res.status(400).json({ error: 'userIds array and reason required.' });

  try {
    const toDeactivate = userIds.filter(id => id !== keepUserId);
    for (const uid of toDeactivate) {
      await manuallySetStatus({ userId: uid, status: 'banned', reason: `Duplicate account. ${reason}`, adminId: req.supabaseUid });
    }
    await logAuditEvent('DUPLICATE_ACCOUNTS_DEACTIVATED', { keepUserId, deactivated: toDeactivate, reason });
    return res.json({ success: true, deactivated: toDeactivate.length });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to deactivate duplicate accounts' });
  }
});

// ─── Legacy endpoints ──────────────────────────────────────────────────────────

securityRouter.post('/verify-transaction', requireSupabaseAuth, (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (!checkVelocity(ip)) {
    logAuditEvent('FRAUD_BLOCK_VELOCITY', { ip });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const riskScore = crypto.randomInt(0, 100);
  if (riskScore >= 80) {
    logAuditEvent('FRAUD_BLOCK_RISK_SCORE', { riskScore });
    return res.status(402).json({ error: 'Transaction flagged for additional verification.', riskScore });
  }
  logAuditEvent('TRANSACTION_APPROVED', { riskScore, userId: req.supabaseUid });
  return res.json({ status: 'approved', riskScore });
});

securityRouter.get('/audit-logs', requireAdmin, (_req: Request, res: Response) => {
  res.json(auditChain.slice(-100));
});

// ── POST /security/sos-alert — Passenger triggers silent in-ride emergency ──
securityRouter.post('/sos-alert', requireSupabaseAuth, async (req: Request, res: Response) => {
  const userId = req.supabaseUid!;
  const { rideId, timestamp } = req.body as { rideId?: string; timestamp?: string };

  try {
    await supabaseAdmin.from('incidents').insert({
      ride_id:       rideId || null,
      passenger_id:  userId,
      reporter_role: 'passenger',
      incid_type:    'sos_alert',
      severity:      'critical',
      incid_status:  'open',
      description:   JSON.stringify({ triggered_at: timestamp || new Date().toISOString(), user_id: userId }),
      created_at:    new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    });

    await logAuditEvent('SOS_ALERT_TRIGGERED', { userId, rideId, timestamp });

    const { data: admins } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('role', 'admin');

    if (admins && admins.length > 0) {
      for (const admin of admins) {
        notifyUser(admin.id, {
          title: '🚨 PASSENGER SOS ALERT',
          body:  `Passenger triggered emergency. Ride: ${rideId ? rideId.slice(-8).toUpperCase() : 'N/A'}. Check admin panel immediately.`,
          data:  { type: 'sos_alert', ride_id: rideId || '', screen: 'admin_incidents', priority: 'critical' },
        }).catch(() => {});
      }
    }

    return res.json({ success: true, message: 'SOS alert logged. Our team has been notified.' });
  } catch (err: any) {
    log.error(`[SECURITY] sos-alert error: ${err.message}`);
    return res.status(500).json({ error: 'Failed to log SOS alert' });
  }
});
