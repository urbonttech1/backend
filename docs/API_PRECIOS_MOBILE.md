# URBONT API — Precios desde el servidor

> **Para:** el desarrollador de la app móvil (`UrbontApp/urbont`)
> **De:** `urbont-api`
> **Fecha:** 2026-09-15 · reemplaza la versión del 2026-09-09
> **Estado:** implementado, pendiente de desplegar
> **Base:** `https://api.urbont.com`

Referencia de los endpoints de precios y de las reglas de espera, no-show y
cancelación, con las **tarifas acordadas con el cliente** (plan en
[`PLAN_TARIFAS_CLIENTE.md`](PLAN_TARIFAS_CLIENTE.md)).

Las respuestas de este documento salen de las funciones reales del motor de cobro,
no están escritas a mano. Los importes son las tarifas por defecto: si un admin las
cambia desde el panel, los endpoints devuelven los valores nuevos de inmediato, sin
redesplegar.

Auth: `Authorization: Bearer <token>` salvo donde se indique.

---

## 0. Qué cambió respecto a la versión anterior

| | Antes | Ahora |
|---|---|---|
| Precio por milla | Uno solo, a partir de 3 millas incluidas en la mínima | **Tres tramos** según la distancia total del viaje |
| Tarifa mínima | Se sumaba a la distancia | Es un **piso**: se cobra lo mayor entre la mínima y la distancia |
| Reserva (`booking_fee`) | $2.50 en todo viaje, +$5 si era programado | **Sólo en programados**: $10 / $15 / $20 según clase |
| Espera | $0.50/min para todas las clases, tope 60 min | Tarifa **por clase**, 5 min gratis, **tope 10 min** |
| Cancelar a demanda | $10 pasados 2 min desde que el chofer aceptó | **Gratis** |
| Cancelar una reserva | Siempre gratis | Gratis ≥ 2 h antes · 50 % entre 2 h y 1 h · 100 % < 1 h |
| No-show | $10 fijos a los 5 min | A demanda: 10 min de espera + 10 % del viaje, a los 15 min. Reserva: 100 %, a los 30 min de la hora |
| Viajes de valet | Pagaban espera y no-show | Sin cargos de espera, no-show ni cancelación |
| Políticas en `/api/config` | No estaban | `pricingPolicy` |

La **forma** de las respuestas no cambió: mismos campos, más `per_mile` y `tier`.
Un APK que no se actualice sigue funcionando; sólo muestra importes nuevos.

---

## 1. Tarifas por clase

| | Sedan | SUV | Van |
|---|---|---|---|
| Tarifa mínima | $17 | $22 | $27 |
| Por milla, viaje de hasta 3 mi | $2.90 | $3.50 | $3.75 |
| Por milla, viaje de más de 3 y hasta 10 mi | $3.00 | $3.50 | $4.00 |
| Por milla, viaje de más de 10 mi | $2.50 | $3.00 | $3.50 |
| Por minuto de trayecto (sobre el 25 % de la duración) | $1.00 | $1.25 | $1.75 |
| Espera por minuto | $0.75 | $1.00 | $1.25 |
| Reserva (sólo programados) | $10 | $15 | $20 |
| Por hora · horas mínimas | $110 · 2 | $145 · 2 | $185 · 2 |

Alias que el servidor acepta en `vehicleType`, sin distinguir mayúsculas:

| Canónica | Alias |
|---|---|
| `sedan` | `business class` · `executive` · `standard` |
| `suv` | `premium suv` · `premier` · `luxury` |
| `van` | `van & sprinter` · `sprinter` · `max` |

Un `vehicleType` desconocido devuelve `400 {"error": "Unknown vehicleType: …"}`.

---

## 2. Cómo se calcula un viaje por distancia

1. **Distancia:** millas × tarifa del tramo al que pertenece el viaje **completo**.
   Un viaje de 10,5 mi va entero al tramo de más de 10.
2. **Sin saltos a la baja:** el importe nunca baja de lo que cuesta el viaje más
   largo del tramo anterior. Sin esto, un sedan de 11 mi (11 × $2.50 = $27.50)
   costaría menos que uno de 10 (10 × $3.00 = $30). Con la regla, cuestan lo mismo.
3. **Base:** lo mayor entre la tarifa mínima y la distancia.
4. **Tiempo:** duración × tarifa por minuto × 0.25.
5. **Recargo por demanda:** multiplica base, distancia y tiempo. **Nunca la reserva.**
6. **Reserva:** sólo si el viaje es programado.
7. **Total:** (base + tiempo + reserva) + 10 %.

El redondeo a dos decimales se aplica **en cada paso**, no sólo al final. El orden
cambia el centavo.

En la respuesta, `base_fare` es la tarifa mínima y `distance_charge` es lo que la
distancia la supera: `base_fare + distance_charge` es el importe del recorrido.

---

## 3. Cotizar

### `GET /api/rides/calculate-fare`

Barato, no llama a Google. Úsalo mientras el usuario arrastra el destino.

#### Por distancia

| Query | Tipo | |
|---|---|---|
| `distanceKm` | number | **obligatorio** |
| `durationMinutes` | number | **obligatorio** |
| `vehicleType` | string | por defecto `sedan` |
| `bookingType` | string | `scheduled` suma la reserva; cualquier otro valor, no |

```jsonc
// GET /api/rides/calculate-fare?distanceKm=12.87&durationMinutes=20&vehicleType=sedan
{
  "base_fare": 17,           // tarifa mínima, con recargo
  "distance_charge": 6.99,   // lo que la distancia supera a la mínima, con recargo
  "time_charge": 5,          // 20 × 1.00 × 0.25
  "booking_fee": 0,          // a demanda: sin reserva
  "ride_fare": 28.99,
  "platform_fee": 2.9,       // 10 % sobre ride_fare
  "total": 31.89,            // ← lo que paga el pasajero
  "surge_multiplier": 1,
  "distance_miles": 8,       // 12.87 km = 7.997 mi, redondeado para mostrar
  "per_mile": 3,             // ← nuevo: tarifa del tramo aplicada
  "tier": 2,                 // ← nuevo: 1 (≤ 3 mi) · 2 (≤ 10 mi) · 3 (> 10 mi)
  "extra_miles": 8,          // heredado: ya no hay millas incluidas
  "included_miles": 0,       // heredado: siempre 0
  "duration_minutes": 20,
  "currency": "USD"
}
```

> **Por qué $31.89 y no $31.90:** 12.87 km son 7.997 millas, no 8. La distancia vale
> 7.997 × $3.00 = $23.99. Con 8 millas exactas el total sería $31.90.

Con `&bookingType=scheduled`:

```jsonc
{ "booking_fee": 10, "ride_fare": 38.99, "platform_fee": 3.9, "total": 42.89, /* … */ }
```

> **Precio por milla para mostrar:** leé `per_mile`. `distance_charge / extra_miles`
> ya no da el precio por milla, porque `distance_charge` es lo que supera a la mínima.

#### Por hora

| Query | Tipo | |
|---|---|---|
| `bookingType` | string | **obligatorio** — literal `hourly` |
| `hours` | number | **obligatorio**, mayor que 0 |
| `vehicleType` | string | por defecto `sedan` |
| `scheduled` | string | `true` suma la reserva |

```jsonc
// GET /api/rides/calculate-fare?bookingType=hourly&hours=4&vehicleType=sedan
{
  "hourly_charge": 440,      // billed_hours × per_hour × recargo
  "booking_fee": 0,          // sin reserva salvo con scheduled=true
  "ride_fare": 440,
  "platform_fee": 44,
  "total": 484,
  "surge_multiplier": 1,
  "billed_hours": 4,         // ← puede ser mayor que requested_hours
  "requested_hours": 4,
  "per_hour": 110,
  "min_hours": 2,
  "currency": "USD"
}
```

Con `&scheduled=true`: `booking_fee: 10`, `total: 495`.

> **El bloque mínimo se cobra completo.** Pedir `hours=1` devuelve `billed_hours: 2`.

---

### `GET /api/rides/estimate`

Calcula la ruta real con Google y valida el área de servicio. Úsalo al confirmar.

| Query | Tipo | |
|---|---|---|
| `pickupLat` · `pickupLng` | number | **obligatorio** |
| `dropoffLat` · `dropoffLng` | number | **obligatorio** |
| `vehicleType` | string | por defecto `standard` |
| `bookingType` | string | `scheduled` suma la reserva |
| `stops` | JSON | opcional — `[{lat,lng}]` |

```jsonc
{
  "base_fare": 17,
  "distance_charge": 12.36,
  "time_charge": 5.8,
  "booking_fee": 0,
  "ride_fare": 35.16,
  "platform_fee": 3.52,
  "total": 38.68,
  "surge_multiplier": 1,
  "distance_miles": 9.79,
  "per_mile": 3,
  "tier": 2,
  "extra_miles": 9.79,
  "included_miles": 0,
  "duration_minutes": 23.2,
  "currency": "USD",
  "distanceMiles": 9.787839020122485,  // duplicados heredados:
  "durationMinutes": 23.2              // usá los snake_case
}
```

Fuera del área: `422 { "error": "outside_service_area" }`, como siempre. Sigue
devolviendo una sola clase por llamada.

---

## 4. Crear el viaje — `POST /api/rides`

- **La reserva la decide el servidor por `scheduled_at`.** Si el viaje tiene hora
  reservada se cobra la reserva de su clase; si no, no. El `booking_type` que manden
  no cambia eso.
- **El recargo lo decide el servidor.** Si mandan `surgeMultiplier`, se toma el
  **menor** entre el suyo y el del servidor.
- **El `fare` se recalcula** si el cuerpo trae `distanceMiles` y `durationMinutes`, y
  sobrescribe el recibido.
- **Por hora:** `booking_type: "hourly"` + `hourly_hours`.

El precio queda congelado en `locked_fare` al crear el viaje: un cambio de tarifas
posterior no lo mueve.

---

## 5. Espera, no-show y cancelación

### Espera

- 5 minutos gratis desde que el chofer marca la llegada.
- Después, la **espera por minuto de la clase**, por minutos enteros.
- **Tope de 10 minutos** cobrables.
- En una **reserva**, la espera empieza a la hora pactada aunque el chofer llegue
  antes.
- Los viajes de **valet** no pagan espera.

Se suma al `fare` al completar el viaje (`wait_fee`).

### No-show — `POST /api/rides/:id/no-show`

Lo marca el chofer. Exige haber marcado la llegada.

| | Cuándo se puede marcar | Qué se cobra |
|---|---|---|
| A demanda | 15 min después de marcar la llegada (5 gratis + 10) | 10 min de espera de la clase + 10 % del viaje |
| Reserva | 30 min después de la hora reservada | El 100 % del viaje; el chofer cobra su parte |
| Valet | igual que su tipo | Nada |

Ejemplo: sedan con viaje de $31.90 → 10 × $0.75 + $3.19 = **$10.69**.

```jsonc
// 200
{ "success": true, "noShowFee": 10.69, "charged": true, "scheduled": false }

// 409 — todavía no se cumplió la espera
{ "error": "Please wait at least 15 minutes before marking no-show",
  "errorCode": "NO_SHOW_TOO_EARLY", "waitedMinutes": 9, "minutesRemaining": 6 }

// 409 — el chofer no marcó la llegada
{ "error": "Mark your arrival at the pickup before marking a no-show.", "errorCode": "NOT_ARRIVED" }
```

### Cancelación por el pasajero — `POST /api/rides/cancel/:id`

| | Cargo |
|---|---|
| Viaje a demanda | **Gratis**, en cualquier momento antes de empezar |
| Reserva, ≥ 2 h antes de la hora | Gratis |
| Reserva, entre 2 h y 1 h antes | 50 % del viaje |
| Reserva, < 1 h antes | 100 % del viaje |
| Viaje de valet | Gratis |

La regla de reservas se aplica **sea cual sea el estado** del viaje. La respuesta
trae el importe cobrado:

```jsonc
{ "success": true, "cancellationFee": 21.45, "stripeChargeId": "pi_…" }
```

El chofer no recibe nada cuando cancela el pasajero.

---

## 6. `GET /api/config` — `pricingPolicy`

Público. Las políticas vienen dentro de la respuesta de siempre:

```jsonc
{
  // … maintenance_mode, min_version, surge_multiplier, claves …
  "pricingPolicy": {
    "currency": "USD",
    "platformCommission": 0.1,
    "mileTiers": { "tier1MaxMiles": 3, "tier2MaxMiles": 10 },
    "wait": { "freeMinutes": 5, "maxBillableMinutes": 10 },
    "noShow": { "onDemandAfterMinutes": 15, "scheduledAfterMinutes": 30 },
    "scheduledCancellation": { "freeHoursBefore": 2, "halfChargeHoursBefore": 1 },
    "onDemandCancellationFee": 0,
    "bookingFeeAppliesTo": "scheduled",
    "valetExempt": true,
    "longPickupFee": 5,
    "longPickupThresholdMinutes": 15
  }
}
```

---

## 7. Qué tiene que cambiar en la app

La app **no la toca backend**: estos cambios son del equipo de la app. Los dejamos
identificados porque, hasta que se hagan, la app muestra reglas que el servidor ya
no aplica.

| Archivo | Qué hace hoy | Qué debería hacer |
|---|---|---|
| `src/screens/booking/utils.ts` | Tabla de respaldo con los precios viejos ($25/$38/$65, $2.50 de reserva siempre) | Tramos, reserva por clase sólo en programados, espera por clase. Se usa si falla la cotización |
| `src/services/fare.ts` | Calcula el precio por milla como `distance_charge / extra_miles` | Leer `per_mile` y `tier` |
| `src/screens/trip/TrackingScreen.tsx` | Espera a $0.50/min sin tope; «cancelación gratis» sólo 2 min | Espera de la clase con tope de 10 min; cancelar a demanda siempre gratis; en reservas, gratis hasta 2 h antes |
| `src/screens/trip/ConfirmedScreen.tsx` | «Cancel for free» sólo 2 min | Misma regla de cancelación |
| `src/screens/driver/DriverModeReimagined.tsx` | Espera a $0.50/min sin tope; texto «$10 no-show fee»; botón de no-show a los 5 min; **ignora el error** si el servidor rechaza | Espera de la clase con tope; importe real del no-show; habilitar el botón a los 15 min (o 30 tras la hora en reservas); mostrar el `error` de la respuesta |
| `src/screens/driver/DriverDashboardMobile.tsx` | No pasa la hora reservada a la pantalla del chofer | Pasar `scheduled_at`, necesario para las reglas de reservas |

> ⚠️ **El que más urge es el del chofer.** El servidor ahora rechaza el no-show con
> `409 NO_SHOW_TOO_EARLY` antes de los 15 minutos, y la app actual se traga ese error:
> el chofer toca el botón y no pasa nada. Todos los valores que necesitan vienen en
> `pricingPolicy` (sección 6).

---

## 8. Pendiente de nuestro lado

| Pendiente | Bloquea |
|---|---|
| `options[]` en `/estimate` | Mostrar las tres clases con una sola llamada |
| `driver_payout` y `commission_amount` en `GET /api/rides/:id` y `ride:new_request` | Borrar las 3 constantes de comisión del APK |
| `valet_fee` en `/api/config` | Borrar el recargo de valet del APK |

**`min_version` sigue en `1.0.0`.** Si cuentan con esa red de seguridad para forzar
la actualización, hay que subirla a mano.

El código de referencia está en `server/config/pricing.ts` y los tests que fijan
estas reglas en `server/config/pricing.test.ts`.
