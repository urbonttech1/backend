import { supabaseAdmin } from '../db/client';

/**
 * El trigger `handle_new_user` de Supabase crea un perfil en cuanto alguien
 * entra con Google por primera vez, y la columna `role` vale 'passenger' por
 * defecto. Ese perfil no es un pasajero real: no tiene nombre, teléfono ni
 * viajes. Sin esta comprobación, el alta de valet o chofer con Google se
 * rechazaba como "ya registrado como pasajero" y la app lo sacaba al instante.
 */
export async function perfilEnBlanco(p: { id: string; role?: unknown; first_name?: unknown; last_name?: unknown; phone?: unknown }): Promise<boolean> {
  if (p.role && p.role !== 'passenger') return false;
  if (p.first_name || p.last_name || p.phone) return false;
  const { count } = await supabaseAdmin.from('rides').select('id', { count: 'exact', head: true }).eq('passenger_id', p.id);
  return (count ?? 0) === 0;
}
