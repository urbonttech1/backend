/**
 * De dónde saca Stripe Tax la jurisdicción.
 *
 * `calculateStripeTax` mandaba la dirección del cliente como `{ country: 'US' }`
 * y nada más. Stripe respondía 400 —«For addresses with country=US, you must
 * provide postal_code»— en todas y cada una de las llamadas, porque el impuesto
 * de ventas en EE. UU. cambia por condado y hasta por ciudad, así que el país
 * solo no le dice nada.
 *
 * El fallo pasaba desapercibido porque el `catch` cae a una tasa plana de
 * respaldo. Es decir: nunca se cobró impuesto calculado por Stripe, siempre el
 * estimado, y nadie se enteró hasta ver los 400 en el panel.
 *
 * Aquí se saca el código postal de la dirección de recogida, que es la que
 * determina dónde ocurre el servicio. Reglas puras, para poder probarlas.
 */

/** Un ZIP de cinco dígitos, con el +4 opcional, como lo escribe Google. */
const ZIP = /\b(\d{5})(?:-\d{4})?\b/;

/**
 * El código postal de una dirección formateada, o null si no lo trae.
 *
 * Devolver null es una respuesta legítima y no un error: una dirección sin
 * código postal significa que hay que usar la tasa de respaldo, no que haya
 * que inventarse uno.
 */
export function codigoPostalDe(direccion: unknown): string | null {
  if (typeof direccion !== 'string') return null;

  // Se busca desde el final: en «123 Main St, Miami, FL 33101, USA» el código
  // postal va al final, y empezar por el principio podría atrapar el número de
  // portal si tuviera cinco cifras.
  const partes = direccion.split(',').reverse();
  for (const parte of partes) {
    const m = ZIP.exec(parte);
    if (m) return m[1];
  }
  return null;
}

/** La dirección de un extremo del viaje, tal como se guarda en `rides`. */
export interface PuntoDelViaje {
  address?: unknown;
}

/**
 * Dónde ocurre el servicio a efectos de impuesto: el punto de recogida.
 *
 * Si la recogida no trae código postal se prueba con el destino, que es mejor
 * que nada: casi todos los viajes empiezan y terminan en la misma jurisdicción.
 */
export function codigoPostalDelViaje(viaje: {
  pickup?: PuntoDelViaje | null;
  dropoff?: PuntoDelViaje | null;
}): string | null {
  return codigoPostalDe(viaje?.pickup?.address) ?? codigoPostalDe(viaje?.dropoff?.address);
}
