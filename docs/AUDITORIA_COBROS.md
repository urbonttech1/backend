# Auditoría de cobros y comisiones

Qué cobra el sistema **hoy, según el código**, y quién se queda con cada parte.

Esto no es el plan de tarifas acordado con el cliente — eso está en
[`PLAN_TARIFAS_CLIENTE.md`](PLAN_TARIFAS_CLIENTE.md). Aquí está lo que el código
hace realmente, que en varios puntos no coincide con lo que la app enseña.

> **Fecha:** 2026-09-30 · **Fuente:** `server/config/pricing.ts`,
> `server/services/rideMetrics.ts`, `valetCommission.ts`, `taxConfig.ts`,
> `rideTip.ts`, `api/rides/cancel.ts`

---

## La conclusión primero

Tres cosas que conviene saber antes de leer el detalle:

1. **La comisión de plataforma NO se suma al precio.** Está contenida dentro de
   él: `total = ride_fare`. Lo que el pasajero ve como "Platform service fee" es
   la parte que URBONT se queda, no un cargo extra.
2. **La app dice 10 % y el sistema cobra 15 %.** El importe es correcto; el texto
   de la etiqueta está escrito a mano y quedó desfasado.
3. **Ningún descuento llega al cobro.** Ni URBONT Pass, ni códigos promocionales,
   ni el corporativo. `pricing.ts` no menciona descuentos ni una sola vez.

---

## 1. Cómo se compone el precio de un viaje

```
base_fare        = minFare × surge
distance_charge  = (importe por tramos − minFare) × surge
time_charge      = minutos × perMin × 0.25 × surge
booking_fee      = serviceFee de la clase   ← SOLO si es programado
booking_fee_flat = $2.50                    ← SIEMPRE
                   ─────────────────────────
ride_fare        = suma de los cinco
platform_fee     = ride_fare × 15 %         ← informativo, NO se suma
total            = ride_fare
impuesto         = total × tasa             ← se añade aparte, al cobrar
```

Dos detalles que no son obvios:

- **El surge nunca toca las reservas.** Multiplica base, distancia y tiempo; el
  `booking_fee` y el `booking_fee_flat` quedan fuera a propósito.
- **El tiempo se factura al 25 %.** `perMin × 0.25`, no `perMin`. El factor viene
  de la tarifa acordada, no es un error de redondeo.

### Ejemplo real (de una captura de producción)

```
Exec. SUV, 7 millas
  Ride fare                     $29.69   ← base + distancia
  Traffic & time estimate        $7.24   ← tiempo
  Booking fee fijo               $2.50   ← NO SE MUESTRA EN LA APP
                                ───────
  Ride subtotal                 $39.43
  Platform service fee (15 %)    $5.91   ← dentro del subtotal, no encima
  Sales tax (6.49 %)             $2.56
                                ───────
  TOTAL                         $41.99
```

Comprobación: `5.91 ÷ 39.43 = 0.1499` → el 15 % se aplica correctamente.

---

## 2. Tarifas por clase de vehículo

| | Standard (Sedan) | Premier (SUV) | Executive Van |
|---|---|---|---|
| Tarifa mínima | $17.00 | $22.00 | $27.00 |
| Por milla · tramo 1 (≤3 mi) | $2.90 | $3.50 | $3.75 |
| Por milla · tramo 2 (3–10 mi) | $3.00 | $3.50 | $4.00 |
| Por milla · tramo 3 (>10 mi) | $2.50 | $3.00 | $3.50 |
| Por minuto | $1.00 | $1.25 | $1.75 |
| Espera por minuto | $0.75 | $1.00 | $1.25 |
| Cargo de reserva (programado) | $10.00 | $15.00 | $20.00 |
| Por hora (modo horas) | $110.00 | $145.00 | $185.00 |
| Mínimo de horas | 2 | 2 | 2 |

El tramo 3 es **más barato** por milla que el 2: los viajes largos bajan de precio
unitario a propósito.

---

## 3. Comisiones — quién se queda qué

### Plataforma: 15 %

```
PLATFORM_COMMISSION = 0.15        pricing.ts:22
COMMISSION_RATE     = 0.15        rideMetrics.ts:28
```

Es **configurable en caliente** desde el panel (`setPlatformCommission`, acepta
entre 0 y 0.5). Leer la constante directamente se queda con el valor del código;
hay que usar `getPlatformCommission()`.

### El reparto real del cobro

`calcularReparto()` en `rideMetrics.ts` es el que manda a Stripe:

```
servicio            = tarifa − comisión del valet
comisión            = servicio × 15 %
───────────────────────────────────────────────
se cobra al pasajero = tarifa + impuesto
va a URBONT          = comisión + impuesto + comisión del valet
va al chofer         = servicio − comisión          (85 %)
```

El impuesto entra en `applicationFeeCents` porque lo declara y lo paga URBONT, no
el chofer.

### Valet: por tramos

```
servicio ≤ $100  →  $10 fijos
servicio > $100  →  10 % del servicio
```

A diferencia de la comisión de plataforma, **esta SÍ se suma** al precio del
huésped y se le transfiere al valet. Se calcula sobre la tarifa oficial del
trayecto, antes de impuesto.

### Propinas: íntegras al chofer

`rideTip.ts` transfiere el 100 % de la propina al chofer. **URBONT no se queda
nada.** Usa `source_transaction` para que salga aunque el saldo de la plataforma
esté a cero.

---

## 4. Cargos fijos y por incidencia

| Cargo | Importe | Cuándo |
|---|---|---|
| **Booking fee fijo** | $2.50 | **Todos** los viajes |
| **Cargo de reserva** | $10 / $15 / $20 según clase | Solo programados |
| **Recogida lejana** | $5.00 | Chofer a más de 15 min del punto |
| **Espera** | $0.75–$1.25/min | Tras 5 min gratis, máximo 10 min facturables |

### No-show

Depende del tipo de viaje:

- **Reserva** → se cobra el **100 %** del viaje.
- **A demanda** → `10 min × tarifa de espera + $2.50 + (mínima × 15 %)`.
  Para un SUV: `10 × 1.00 + 2.50 + 22.00 × 0.15` = **$17.80**.
- **Valet** → $0, exento.

Se puede marcar no-show tras 10 min de espera extra; en reservas, 30 min después
de la hora pactada.

### Cancelación de una reserva

| Antelación | Se cobra |
|---|---|
| ≥ 2 h | 0 % |
| 1–2 h | 50 % |
| < 1 h | 100 % |

Valet exento.

### Bonos al chofer (no son cobros, son pagos)

```
 5 viajes consecutivos  →  $3
10 viajes consecutivos  →  $7
20 viajes consecutivos  → $15
```

---

## 5. Impuestos

```
TASA_POR_DEFECTO = 0.065   (6.5 %)
TASA_MAXIMA      = 0.30
```

La tasa real **se resuelve por código postal del punto de recogida**
(`taxLocation.ts`), con esa por defecto como respaldo. Por eso solo se conoce al
final del flujo y no en la pantalla de selección de vehículo.

Se **suma** al total, no está contenido en él.

---

## 6. Hallazgos

### 🔴 El booking fee de $2.50 no se muestra

El backend lo mete dentro de `ride_fare`, pero la app solo pinta la fila
"Booking fee" en viajes programados. Resultado: el pasajero ve un subtotal $2.50
mayor que la suma de las líneas que tiene delante. Es el tipo de diferencia por
la que la gente escribe a soporte.

### 🔴 La etiqueta dice 10 %, se cobra 15 %

Texto escrito a mano en `PaymentConfirmationScreen.tsx`, líneas 181 y 204. Y como
la comisión es configurable desde el panel, la etiqueta quedaría mal otra vez en
cuanto alguien la cambie.

### 🔴 Dos fuentes de verdad para el porcentaje

```
app      PLATFORM_FEE_RATE  = 0.10    src/screens/booking/utils.ts:26
backend  PLATFORM_COMMISSION = 0.15   pricing.ts:22
```

Hoy no afecta al importe cobrado, porque la comisión no se suma al total y la
pantalla de confirmación usa el cálculo del servidor
(`serverDistance ?? localBreakdown`). Pero cualquier pantalla que use el cálculo
local enseña un desglose distinto al que se cobra.

### 🔴 Ningún descuento llega al cobro

`pricing.ts` tiene **cero** referencias a descuentos, y la creación del
PaymentIntent tampoco los aplica. URBONT Pass, códigos promocionales y planes
corporativos calculan una rebaja que nunca se resta. Confirmado también en
[`PLANES_EMPRESA.md`](PLANES_EMPRESA.md).

### 🟡 El precio sube entre pantallas, y es correcto

No es un error de cálculo: las pantallas previas muestran la tarifa **sin
impuesto**, porque la tasa depende del código postal y aún no se conoce. El salto
es exactamente el impuesto.

Es correcto técnicamente, pero sorprende al usuario. Merece o un aviso
("impuestos no incluidos") o mostrar una estimación antes.

---

## 7. Dónde está cada cosa

| Qué | Archivo |
|---|---|
| Tarifas, tramos, surge, booking fees, no-show, cancelación | `server/config/pricing.ts` |
| Reparto chofer/plataforma que va a Stripe | `server/services/rideMetrics.ts` |
| Comisión del valet | `server/services/valetCommission.ts` |
| Tasa de impuesto y su resolución | `server/services/taxConfig.ts`, `taxLocation.ts` |
| Propinas | `server/services/rideTip.ts` |
| Cancelación y no-show (endpoints) | `server/api/rides/cancel.ts` |
| Políticas publicadas a app y panel | `getPricingPolicy()` en `pricing.ts` |

`getPricingPolicy()` ya expone comisión, booking fee, tramos y reglas de espera.
**La app podría leer de ahí en vez de tener sus propias constantes** — resolvería
los hallazgos 2 y 3 de un golpe.
