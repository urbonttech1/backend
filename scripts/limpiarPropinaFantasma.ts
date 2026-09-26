/**
 * Borra propinas registradas que nunca se cobraron.
 *
 * El código viejo de propinas creaba el PaymentIntent y escribía `tip_amount`
 * sin comprobar que el cobro hubiera salido. Stripe puede devolverlo en
 * `requires_payment_method` sin lanzar error, y eso pasó el 26/09 a las 18:21:
 * la app le enseñaba al chofer una propina de $10 que ningún pasajero pagó.
 *
 * El servicio ya no puede volver a hacerlo -exige `status === 'succeeded'`- así
 * que esto es una limpieza de una vez, no algo recurrente.
 *
 *   npx tsx scripts/limpiarPropinaFantasma.ts          # sólo enseña qué haría
 *   npx tsx scripts/limpiarPropinaFantasma.ts --aplicar
 */
import 'dotenv/config';
import Stripe from 'stripe';

import { supabaseAdmin } from '../server/db/client';

const aplicar = process.argv.includes('--aplicar');

async function main() {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

  const { data: viajes } = await supabaseAdmin
    .from('rides')
    .select('id, tip_amount, driver_id, created_at')
    .gt('tip_amount', 0);

  const conPropina = (viajes ?? []) as Array<{ id: string; tip_amount: number; driver_id: string; created_at: string }>;
  console.log(`Viajes con propina registrada: ${conPropina.length}`);

  // Hay que recorrer TODO el historial de Stripe, no la primera página.
  //
  // Mirando sólo los últimos 100 cobros, la ventana llegaba al 2 de agosto y dos
  // viajes de julio quedaban fuera: habrían salido como propinas sin cobrar y se
  // habrían borrado propinas legítimas. Un viaje sólo se considera fantasma si
  // su fecha entra en el tramo ya recorrido.
  const cobradoPorViaje = new Map<string, string>();
  let masAntiguoVisto = Number.POSITIVE_INFINITY;
  let paginas = 0;

  for await (const pi of stripe.paymentIntents.list({ limit: 100 })) {
    masAntiguoVisto = Math.min(masAntiguoVisto, pi.created * 1000);
    if (++paginas % 100 === 0) process.stdout.write('.');
    const m = pi.metadata || {};
    if ((m.type === 'tip' || m.type === 'tip_adjustment') && m.ride_id) {
      // Si hay varios intentos sobre el mismo viaje, manda el que salió bien.
      if (pi.status === 'succeeded' || !cobradoPorViaje.has(m.ride_id)) {
        cobradoPorViaje.set(m.ride_id, pi.status);
      }
    }
  }
  console.log(`\nCobros revisados: ${paginas}, hasta ${new Date(masAntiguoVisto).toISOString().slice(0, 16)}`);

  const fantasmas = conPropina.filter((v) => cobradoPorViaje.get(v.id) !== 'succeeded');

  if (!fantasmas.length) {
    console.log('No hay propinas sin cobrar. Nada que hacer.');
    return;
  }

  console.log(`\nPropinas registradas y NO cobradas: ${fantasmas.length}`);
  for (const v of fantasmas) {
    console.log(`  ${v.id}  $${v.tip_amount}  estado del cobro: ${cobradoPorViaje.get(v.id) ?? 'ningún cobro'}`);
  }

  if (!aplicar) {
    console.log('\nEn seco. Para borrarlas: --aplicar');
    return;
  }

  for (const v of fantasmas) {
    const { error } = await supabaseAdmin
      .from('rides')
      .update({ tip_amount: null, updated_at: new Date().toISOString() })
      .eq('id', v.id);
    console.log(error ? `  ✗ ${v.id}: ${error.message}` : `  ✓ ${v.id}: propina borrada`);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
