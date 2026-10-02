/**
 * ¿Puede un valet entrar y despachar?
 *
 * Antes solo se miraba `profiles.account_status`. Pero la solicitud que llega por
 * la web crea el perfil sin ese campo —queda «active» por defecto— y la decisión
 * del panel vive en `valet_applications.status`. Un valet con la solicitud aún
 * pendiente podía entrar en cuanto fijara una contraseña. Aquí se cruzan las dos.
 */
import { supabaseAdmin } from '../db/client';

export type AccesoValet = 'ok' | 'pending' | 'suspended' | 'rejected';

/** Regla pura: la suspensión y el rechazo mandan sobre «pendiente». */
export function estadoAcceso(opts: {
  accountStatus?: string | null;
  applicationStatus?: string | null;
}): AccesoValet {
  const cuenta = opts.accountStatus ?? 'active';
  const solicitud = opts.applicationStatus ?? null;
  if (solicitud === 'rejected') return 'rejected';
  if (cuenta === 'suspended') return 'suspended';
  if (cuenta === 'pending' || solicitud === 'pending') return 'pending';
  return 'ok';
}

/** Lee la solicitud por correo y aplica la regla. Si la consulta falla, solo cuenta el perfil. */
export async function accesoValet(accountStatus: string | null | undefined, email: string | null | undefined): Promise<AccesoValet> {
  let applicationStatus: string | null = null;
  if (email) {
    try {
      const { data } = await supabaseAdmin.from('valet_applications').select('status').ilike('email', email).maybeSingle();
      applicationStatus = (data?.status as string | undefined) ?? null;
    } catch { /* sin tabla o sin red: se decide con el perfil */ }
  }
  return estadoAcceso({ accountStatus, applicationStatus });
}
