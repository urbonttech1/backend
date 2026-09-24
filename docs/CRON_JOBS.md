# URBONT API — Jobs Programados (cron)

Referencia de los 15 jobs de [`server/jobs/cron.ts`](../server/jobs/cron.ts): qué
hace cada uno, cómo se comporta al correr varias instancias del server, y cómo
arreglarlo.

Todos se registran en `startCronJobs()` ([`cron.ts:609`](../server/jobs/cron.ts#L609)),
que se invoca sin ninguna guarda desde [`server.ts:985`](../server.ts#L985). Es
decir: **cada instancia del server ejecuta los 15 jobs**.

---

## Resumen

| Job | Frecuencia | Con 2+ instancias | Ya falla con 1 |
|---|---|---|---|
| `staleRideWatchdog` | cada 2 min | 🔴 Reasigna el mismo viaje 2 veces | — |
| `driverAcceptanceTimeout` | cada 5 min | 🔴 Match sobre pool parcial | — |
| `dispatchScheduledRides` | cada 5 min | 🔴 Dispatch y push duplicados | — |
| `checkDocumentExpiry` | 08:00 diario | 🟠 Push duplicado | 🔴 Sí |
| `sendScheduledRideReminders` | cada 5 min | 🟠 Push duplicado | 🔴 Sí |
| `sendRateReminders` | cada 30 min | 🟠 Push duplicado | 🔴 Sí |
| `autoSurge` | cada 5 min | 🟠 Push duplicado | — |
| `sendWeeklyEarningsSummary` | Lunes 09:00 | 🟠 Push duplicado | — |
| `anonymizeOldRides` | 00:00 diario | 🟢 Idempotente | 🟡 Reprocesa histórico |
| `cancelExpiredSearchingRides` | cada 15 min | 🟢 Seguro | — |
| `pagarChoferesPendientes` | cada 15 min | 🟢 Idempotente en Stripe | — |
| `resetStaleStreaks` | cada hora | 🟢 Seguro | — |
| `flagInactiveDrivers` | 03:00 diario | 🟢 Seguro | — |
| `checkCancellationPatterns` | cada 6 h | 🟢 Seguro | — |

---

## El patrón que hace un job seguro

Antes de los detalles, la regla general. Un job es seguro frente a duplicación si
**reclama la fila antes de actuar**, en una sola sentencia atómica:

```ts
// UPDATE condicional + RETURNING: solo una instancia recibe la fila
const { data: claimed } = await supabaseAdmin
  .from('rides')
  .update({ reminder_24h_sent: true })
  .eq('id', ride.id)
  .eq('reminder_24h_sent', false)   // ← el guard
  .select('id');

if (!claimed?.length) continue;      // otra instancia (u otro tick) ya la tomó
await notifyUser(...);               // solo actúa quien ganó la carrera
```

Funciona porque en Postgres (READ COMMITTED) la segunda instancia espera el lock
de fila, reevalúa el `WHERE` contra la versión ya actualizada, no coincide, y no
recibe nada en el `RETURNING`.

Los dos antipatrones que aparecen en el código son:

| Antipatrón | Por qué falla |
|---|---|
| **Read-then-notify** — `SELECT` y luego notificar, sin escribir nada | Ambas instancias leen las mismas filas y ambas notifican |
| **Read-then-write** — leer el flag, notificar, y después marcarlo | Ambas leen `false`, ambas notifican, ambas escriben `true` |

`cancelExpiredSearchingRides` ([`cron.ts:76-93`](../server/jobs/cron.ts#L76-L93))
ya implementa el patrón correcto. Es la referencia a copiar.

---

## 🔴 Críticos

### `staleRideWatchdog` — cada 2 min

[`cron.ts:116-148`](../server/jobs/cron.ts#L116-L148)

**Qué hace:** busca viajes con el conductor inactivo (`findStaleRides()`) y los
reasigna a otro conductor.

**Con 2+ instancias:** el guard contra doble procesamiento es `reassigningRideIds`,
un **`Set` en memoria del proceso** ([`cron.ts:114`](../server/jobs/cron.ts#L114)).
Dos instancias tienen dos Sets independientes, así que el guard no protege nada
entre ellas. **El mismo viaje se reasigna a dos conductores distintos**, cada 2
minutos. Es el único job de la lista que produce datos incorrectos, no solo ruido.

**Arreglo:** el `Set` en memoria delata que el autor ya sabía que hacía falta
exclusión mutua — solo está al nivel equivocado. Sustituirlo por un lock en la
base de datos:

```ts
// Reclama el viaje con un lock a nivel de fila antes de reasignar
const { data: claimed } = await supabaseAdmin
  .from('rides')
  .update({ reassigning_at: new Date().toISOString() })
  .eq('id', r.id)
  .or(`reassigning_at.is.null,reassigning_at.lt.${new Date(Date.now() - 120_000).toISOString()}`)
  .select('id');
if (!claimed?.length) continue;
```

El `OR` con ventana de 2 minutos libera el lock automáticamente si la instancia
que lo tomó murió a mitad del proceso.

---

### `driverAcceptanceTimeout` — cada 5 min

[`cron.ts:245-275`](../server/jobs/cron.ts#L245-L275)

**Qué hace:** re-despacha viajes que llevan más de 5 minutos en `searching` sin
que ningún conductor los acepte.

**Con 2+ instancias:** es read-then-notify puro — `SELECT` y luego
`notifyAvailableDrivers()`, sin escribir ningún estado.

El efecto es más sutil de lo que parece. `notifyAvailableDrivers` solo usa sockets
(`io.to(sid).emit`, [`socketService.ts:857-878`](../server/services/socketService.ts#L857-L878)),
sin FCM, y cada conductor está conectado a exactamente una instancia. Así que los
emits **se reparten en lugar de duplicarse**. El problema real es otro: las
oleadas de dispatch con scoring operan sobre `driverSocketMap`, que en cada
instancia contiene **solo la mitad de los conductores**. El "mejor conductor" se
elige sobre un subconjunto parcial.

**Arreglo:** depende de arreglar `driverSocketMap` primero (emitir a rooms
`driver:${driverId}` en lugar de a `socketId`, ver
[`socketService.ts:559-569`](../server/services/socketService.ts#L559-L569)). Con
las rooms sobre el adapter de Redis, el pool vuelve a ser global. Mientras eso no
esté, este job necesita un único ejecutor.

---

### `dispatchScheduledRides` — cada 5 min

[`cron.ts:287-394`](../server/jobs/cron.ts#L287-L394)

**Qué hace:** tres cosas en un solo job.

1. Cancela viajes `scheduled` cuya hora de recogida ya pasó hace más de 30 min.
2. Transiciona `scheduled` → `searching` los que entran en la ventana de 35 min, y
   los despacha a conductores.
3. Reintenta las notificaciones al pasajero que no se enviaron (`dispatch_35m_sent = false`).

**Con 2+ instancias:** cada paso se comporta distinto.

| Paso | Estado | Motivo |
|---|---|---|
| 1 — cancelar vencidos ([línea 296](../server/jobs/cron.ts#L296)) | 🟢 Seguro | `UPDATE ... .eq('ride_status','scheduled') ... .select()` — patrón correcto |
| 2 — transición ([línea 334](../server/jobs/cron.ts#L334)) | 🔴 Duplica | El `UPDATE` tiene guard, pero el código **solo comprueba `updateErr`, nunca si afectó filas** |
| 3 — retry ([línea 370](../server/jobs/cron.ts#L370)) | 🔴 Duplica | Read-then-write sobre `dispatch_35m_sent` |

El paso 2 es un caso de libro: el guard protege la escritura en la base de datos y
deja pasar los efectos secundarios. La instancia que pierde la carrera sigue
adelante y ejecuta `notifyAvailableDrivers()` y el push al pasajero.

**Arreglo del paso 2** — comprobar que se reclamó la fila:

```ts
const { data: claimed, error: updateErr } = await supabaseAdmin
  .from('rides')
  .update({ ride_status: 'searching', updated_at: now.toISOString() })
  .eq('id', ride.id)
  .eq('ride_status', 'scheduled')
  .is('driver_id', null)
  .select('id');                        // ← añadir

if (updateErr) { /* log */ continue; }
if (!claimed?.length) continue;         // ← añadir: otra instancia ya la transicionó
```

**Arreglo del paso 3** — reclamar el flag antes de notificar, no después
(ver el patrón general arriba).

---

## 🟠 Duplican notificaciones

No corrompen datos, pero el usuario recibe el mismo push N veces, donde N es el
número de instancias.

### `autoSurge` — cada 5 min

[`cron.ts:150-238`](../server/jobs/cron.ts#L150-L238)

**Qué hace:** calcula el ratio viajes/conductores, ajusta `surge_multiplier` en
`app_config`, emite `surge:changed` por socket y notifica por push a los
conductores online cuando el surge sube.

**Con 2+ instancias:** ambas leen el mismo `currentMultiplier`, ambas ven el mismo
delta, ambas hacen el `upsert` (mismo valor, inofensivo) y ambas llaman a
`notifyOnlineDriversOfSurge`. **Cada conductor online recibe 2 push de surge.**

**Arreglo:** condicionar el upsert al valor previo, para que solo una instancia
gane y solo ella notifique:

```ts
const { data: claimed } = await supabaseAdmin
  .from('app_config')
  .update({ value: String(surgeMultiplier), updated_at: new Date().toISOString() })
  .eq('key', 'surge_multiplier')
  .eq('value', String(currentMultiplier))   // ← solo si nadie lo cambió antes
  .select('key');
if (!claimed?.length) return;               // otra instancia ya aplicó el cambio
```

---

### `sendWeeklyEarningsSummary` — Lunes 09:00

[`cron.ts:479-526`](../server/jobs/cron.ts#L479-L526)

**Qué hace:** agrega los viajes completados de la semana pasada por conductor y le
envía su resumen de ingresos (90% de la tarifa).

**Con 2+ instancias:** sin flag, notificación pura. Cada conductor recibe el
resumen de ingresos dos veces. Frecuencia baja, pero es un mensaje sobre dinero, y
duplicado se lee como un error de cálculo.

**Arreglo:** tabla `weekly_summary_sent (driver_id, week_start)` con clave
primaria compuesta; el `INSERT` que falla por conflicto indica que otra instancia
ya lo envió.

---

### `checkDocumentExpiry` — 08:00 diario · 🔴 ya falla con 1 instancia

[`cron.ts:693-768`](../server/jobs/cron.ts#L693-L768)

**Qué hace:** revisa documentos de conductor por vencer. Avisa a 30 días, a 7
días, y al vencerse suspende la cuenta.

**Con 2+ instancias:** las ramas de 30 y 7 días tienen flags (`notified_30d`,
`notified_7d`) pero son read-then-write, así que duplican.

**Ya falla con 1 instancia:** la rama de documento vencido
([`cron.ts:720-734`](../server/jobs/cron.ts#L720-L734)) **no tiene ningún flag**.
El job corre cada día, vuelve a encontrar el mismo documento vencido, y vuelve a
suspender y notificar. Un conductor con la licencia caducada recibe el push
*"⚠️ Document Expired — Account Suspended"* **cada mañana, indefinidamente**,
hasta que suba el documento.

**Arreglo:** añadir una columna y comprobarla en la rama de vencido:

```sql
ALTER TABLE driver_documents
  ADD COLUMN IF NOT EXISTS suspended_notified_at TIMESTAMPTZ;
```

```ts
if (expiry <= today) {
  const { data: claimed } = await supabaseAdmin
    .from('driver_documents')
    .update({ suspended_notified_at: now.toISOString() })
    .eq('id', docId)
    .is('suspended_notified_at', null)
    .select('id');
  if (!claimed?.length) continue;   // ya se notificó la suspensión
  // ... suspender y notificar
}
```

Y en las ramas de 7 y 30 días, reclamar el flag antes de notificar en lugar de
después.

---

### `sendScheduledRideReminders` — cada 5 min · 🔴 ya falla con 1 instancia

[`cron.ts:399-446`](../server/jobs/cron.ts#L399-L446)

**Qué hace:** recordatorios al pasajero 24 h y 1 h antes de un viaje programado.

**Ya falla con 1 instancia.** El comentario de
[`cron.ts:398`](../server/jobs/cron.ts#L398) afirma:

> *"Uses a 10-minute window per check; with a 5-min cron this is safe from doubles."*

Es al contrario. La ventana de 24 h es `scheduled_at ∈ [now+23h55m, now+24h5m]` —
**10 minutos de ancho**, evaluada **cada 5 minutos**. Un viaje concreto cae dentro
en 2 o 3 ticks consecutivos. Sin columna de flag, el pasajero recibe **2-3 avisos
de 24 h** y otros **2-3 de 1 h**. Con 2 instancias, 4-6 de cada.

**Arreglo:** dos columnas de flag, con el mismo patrón que ya usa
`dispatch_35m_sent`:

```sql
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent  BOOLEAN NOT NULL DEFAULT false;
```

Reclamar el flag antes de notificar (patrón general arriba). Esto arregla a la vez
la duplicación por ventana solapada y la duplicación por instancias.

---

### `sendRateReminders` — cada 30 min · 🔴 ya falla con 1 instancia

[`cron.ts:449-476`](../server/jobs/cron.ts#L449-L476)

**Qué hace:** pide calificar el viaje 2 h después de completarlo, si sigue sin
calificación.

**Ya falla con 1 instancia:** mismo error de ventana. El rango es "completado hace
2-3 h" — **60 minutos de ancho** — evaluado **cada 30 minutos**. Dos ticks por
viaje, sin flag. Cada pasajero recibe la petición dos veces.

**Arreglo:**

```sql
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS rate_reminder_sent BOOLEAN NOT NULL DEFAULT false;
```

Y reclamar el flag antes de notificar.

---

## 🟢 Seguros

Estos cinco no necesitan cambios para escalar. Vale la pena entender por qué,
porque es el patrón a replicar en los demás.

### `cancelExpiredSearchingRides` — cada 15 min

[`cron.ts:70-111`](../server/jobs/cron.ts#L70-L111) · **La referencia a copiar.**

Cancela viajes en `searching` sin conductor: inmediatos con más de 2 h, y
programados cuya hora pasó hace más de 30 min. Usa
`UPDATE ... .eq('ride_status','searching') ... .select('id, passenger_id')` y
notifica **solo a las filas que esa instancia cambió realmente**. Correcto por
construcción.

También se ejecuta una vez al arrancar ([`cron.ts:611`](../server/jobs/cron.ts#L611)),
así que en un despliegue rolling cada task nuevo lo dispara. Sigue siendo seguro
por el mismo motivo.

### `pagarChoferesPendientes` — cada 15 min

**La red de seguridad del pago al chofer.**

Busca viajes completados con `driver_earnings > 0` y `stripe_transfer_id` nulo y
transfiere lo que se deba, comprobando antes contra Stripe si el chofer ya puede
recibir transferencias. Existe porque el pago del momento dependía de que
`profiles.stripe_connect_status` dijera `'active'`, columna que solo escribía el
webhook `account.updated` — un webhook al que el endpoint de Stripe nunca estuvo
suscrito. Resultado: viajes cobrados al pasajero cuyo chofer no vio un centavo.

Seguro con varias instancias porque cada transferencia va con
`idempotencyKey: driver_catchup_<rideId>_<accountId>`: si dos tasks procesan el
mismo viaje a la vez, Stripe crea una sola transferencia y devuelve la misma a
la segunda. La lógica vive en
[`payoutRecovery.ts`](../server/services/payoutRecovery.ts); las reglas puras,
en `connectStatus.ts` y `pendingPayouts.ts`, con tests.

### `resetStaleStreaks` — cada hora

[`cron.ts:529-541`](../server/jobs/cron.ts#L529-L541)

Pone `consecutive_trips = 0` a los conductores offline más de 12 h. El `WHERE`
incluye `consecutive_trips > 0`, así que tras el primer update ya no coincide con
nada. Idempotente, y no notifica a nadie.

### `flagInactiveDrivers` — 03:00 diario

[`cron.ts:544-569`](../server/jobs/cron.ts#L544-L569)

Marca `needs_review = true` a conductores con 30+ días sin actividad. El `WHERE`
filtra por `needs_review = false`. Idempotente, sin notificaciones.

### `checkCancellationPatterns` — cada 6 h

[`cron.ts:572-607`](../server/jobs/cron.ts#L572-L607)

Marca para revisión a conductores con más de 3 cancelaciones en 7 días. Mismo
guard `.eq('needs_review', false)` ([línea 601](../server/jobs/cron.ts#L601)).
Idempotente, sin notificaciones.

### `anonymizeOldRides` — 00:00 diario

[`cron.ts:11-62`](../server/jobs/cron.ts#L11-L62)

Redacta PII (direcciones, notas) de viajes completados hace más de 30 días.
Escribir `[REDACTED]` dos veces da el mismo resultado, así que es seguro.

**🟡 Pero es ineficiente:** la query no excluye los viajes ya redactados, así que
cada noche reprocesa el catálogo histórico completo en lotes de 100. Hoy son
segundos; con 100k viajes acumulados serán minutos de escrituras inútiles cada
noche.

```sql
ALTER TABLE rides ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
```

Filtrar por `.is('anonymized_at', null)` y sellarla en el update.

---

## Arreglo global: un único ejecutor

Hacer los 15 jobs seguros para concurrencia, uno por uno, es bastante trabajo.
Designar un único proceso que los ejecute resuelve los tres críticos de golpe sin
refactorizar nada.

**1.** Poner una guarda en [`server.ts:985`](../server.ts#L985):

```ts
if (process.env.CRON_ENABLED !== 'false') startCronJobs();
```

**2.** En ECS, dos servicios sobre el mismo task definition:

| Servicio | `CRON_ENABLED` | En el ALB | `desiredCount` |
|---|---|---|---|
| `urbont-api` (web) | `false` | Sí | 2+ |
| `urbont-cron` | `true` | No | **1** |

Detalle en el Paso 10 de [`AWS_ECS_DEPLOY.md`](AWS_ECS_DEPLOY.md).

Con esto, los jobs vuelven a las mismas garantías que tienen hoy con una sola
instancia — que no son perfectas, porque los tres bugs de ventana solapada siguen
ahí, pero al menos no se multiplican.

---

## Orden de trabajo recomendado

| # | Tarea | Por qué primero |
|---|---|---|
| 1 | Flag de `checkDocumentExpiry` en la rama de vencido | Afecta a conductores reales hoy, cada mañana, con un mensaje acusatorio |
| 2 | Flags de `sendScheduledRideReminders` y `sendRateReminders` | Push duplicados en producción ahora mismo |
| 3 | `CRON_ENABLED` + servicio separado | Requisito para escalar a 2+ tasks |
| 4 | Comprobar filas afectadas en `dispatchScheduledRides` paso 2 y 3 | Barato, y elimina el caso más sutil |
| 5 | Lock en DB para `staleRideWatchdog` | Solo necesario si algún día quieres más de un ejecutor de cron |
| 6 | `anonymized_at` en `anonymizeOldRides` | Optimización; urge cuando crezca el histórico |

Los puntos 1 y 2 son independientes de la plataforma y valen más que la migración
a AWS: son bugs visibles para el usuario, en producción, hoy.

---

*Documento del equipo técnico de URBONT · Septiembre 2026*
