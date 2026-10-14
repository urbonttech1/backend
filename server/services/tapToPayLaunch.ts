/**
 * Lanzamiento de Tap to Pay on iPhone: a quién va y cuánto se ha enviado. El
 * contenido (email y push) está en tapToPayLaunchEmail.ts.
 *
 * Por ahora sólo alimenta la vista previa del panel; el envío —una sola vez
 * por persona y canal, registrado en marketing_sends— se añade aparte.
 */
import { pool } from '../db/pool';

export const CAMPANA = 'tap_to_pay_launch';

/** Quién recibe el lanzamiento: conductores aprobados y activos que usan iPhone. */
export async function destinatarios(): Promise<{ id: string; email: string | null }[]> {
  const { rows } = await pool.query<{ id: string; email: string | null }>(`
    SELECT p.id, p.email
      FROM profiles p
     WHERE p.role IN ('chauffeur', 'driver')
       AND p.verification_status = 'approved'
       AND COALESCE(p.account_status, 'active') = 'active'
       AND EXISTS (SELECT 1 FROM user_push_tokens t WHERE t.user_id = p.id AND t.platform = 'ios')
  `);
  return rows;
}

/** Cuántos hay y a cuántos ya se les mandó cada canal. */
export async function resumen(): Promise<{ destinatarios: number; conEmail: number; emailEnviados: number; pushEnviados: number }> {
  const lista = await destinatarios();
  const { rows } = await pool.query<{ channel: string; n: string }>(
    `SELECT channel, COUNT(*) AS n FROM marketing_sends WHERE campaign = $1 GROUP BY channel`, [CAMPANA],
  );
  const enviados = (canal: string) => Number(rows.find(r => r.channel === canal)?.n ?? 0);
  return {
    destinatarios: lista.length,
    conEmail: lista.filter(d => d.email).length,
    emailEnviados: enviados('email'),
    pushEnviados: enviados('push'),
  };
}
