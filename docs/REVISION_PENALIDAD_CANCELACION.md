# Penalidad por cancelar una reserva — guía de revisión

> Para quien revise este cambio. Explica **qué se tocó, por qué, y dónde mirar
> con más cuidado**. Son dos repos: `backend` y la app (`urbont`).
>
> Estado: implementado y con tests. **Sin desplegar y sin activar.**

---

## Qué problema resuelve

Soltar una reserva ya aceptada no costaba nada. El chofer la devolvía al pool,
se la ofrecía a otro y nadie pagaba. Un chofer podía tomar una reserva para
asegurarse el hueco y soltarla media hora antes del servicio, dejando al
pasajero sin coche y al dispatcher buscando reemplazo a mano.

Ahora, al aceptar asume el servicio. Si lo suelta, paga un porcentaje del valor
de la reserva que crece según se acerca la hora.

| Cuándo suelta | Penalidad | Sobre $100 |
|---|---|---|
| Dentro de los 5 min desde que aceptó | 0 % | $0 |
| Pasados los 5 min, falta más de 2 h | 20 % | $20 |
| Falta más de 1 h, hasta 2 h | 40 % | $40 |
| Falta más de 30 min, hasta 1 h | 60 % | $60 |
| Falta 30 min o menos, o la hora ya pasó | 100 % | $100 |

**Lo que NO cambia:** la reserva se sigue reofreciendo a otros choferes
inmediatamente, y el pasajero sigue sin pagar nada. La penalidad se añade
encima del comportamiento que ya existía; no lo sustituye.

---

## Por dónde empezar a revisar

En este orden, de más puro a más delicado:

1. `server/services/cancellationPenalty.ts` — las reglas. Sin base de datos ni
   Stripe. Es donde está la política y se lee en cinco minutos.
2. `server/services/cancellationPenalty.test.ts` — 28 tests. Los cinco ejemplos
   de la política y todos los bordes.
3. `server/services/cancellationPenaltyStore.ts` — lo que escribe en la base.
4. `server/api/rides/cancel.ts` — el enganche.
5. **`server/services/ridePayout.ts`** — el cobro. **Aquí es donde se mueve
   dinero real; si solo vas a revisar un archivo, que sea este.**

---

## Decisiones que conviene discutir

Estas tres no son evidentes. Si algo se va a cambiar, probablemente sea esto.

### 1. El corte del 100 % está en 30 minutos, y es una deducción

La tabla original de la política se contradecía. Decía a la vez:

- «falta **1 hora o menos**, pero más de 0 minutos» → 60 %
- «falta **menos de 1 hora**» → 100 %

Los dos tramos cubren el mismo rango. Tal como estaba escrito, según el orden en
que se evaluaran los `if`, o el 60 % solo existía en el instante exacto de
60:00 minutos, o el 100 % no se aplicaba nunca.

Los ejemplos de la propia política sí lo resuelven: a 1 h cobra $60 y a 30 min
cobra $100. De ahí sale el corte en 30 minutos. **No está confirmado por
escrito.** Vive en la constante `TRAMO_INMINENTE_MINUTOS`: cambiarla es cambiar
un número y dos asserts.

### 2. La exención de 5 minutos gana siempre, y eso deja un hueco

La política dice que la exención aplica «únicamente si la cancelación ocurre
dentro de ese plazo desde la aceptación», sin más condiciones. Está implementado
así, literalmente.

El efecto: **aceptar una reserva que empieza en 20 minutos y soltarla a los 2
sale gratis.** Es justo el caso que más daño hace. Hay un test que lo fija
explícitamente (`la exención manda sobre el tiempo restante`), para que si
alguien lo cambia sepa que está cambiando algo intencionado y no arreglando un
descuido.

La corrección, si se decide: que la exención no aplique cuando falte menos de 1 h.

### 3. Una penalidad no se parte

El cobro salda las deudas más viejas que **quepan enteras** en lo que el chofer
acaba de ganar. No hay cobros parciales.

Es deliberado: cobrar media deja la fila a medio pagar y obliga a llevar la
cuenta de lo ya descontado, que es donde se cuelan los errores de dinero.

**La limitación conocida:** una penalidad mayor que lo que el chofer gana en un
solo viaje nunca se cobra sola. Se queda en `recorded` esperando un viaje que la
cubra, o a que el admin la gestione. Con una reserva de $300 al 100 %, eso puede
tardar. Si molesta, la salida es añadir `amount_settled` y permitir parciales.

---

## Los dos sitios con riesgo de cobrar de más

### El doble cobro de la misma cancelación

Lo impide el **índice único `(ride_id, driver_id)`** de
`driver_cancellation_penalties`, no una comprobación en código. Dos peticiones
de cancelación simultáneas insertan una sola fila, porque el `upsert` va con
`ignoreDuplicates`.

Si alguien quita ese índice en una migración futura, el doble cobro vuelve sin
que ningún test lo note. Merece la pena saberlo.

### El doble cobro vía `driver_earnings` — este ya mordió

En `ridePayout.ts`, el descuento **solo cuenta si la transferencia a Stripe se
hizo de verdad**:

```ts
const earningsCents = driverTransferId ? payoutCents : metrics.driverPayoutCents;
```

La primera versión de este cambio escribía siempre el importe ya descontado. Con
un chofer sin Stripe Connect activo eso dejaba `driver_earnings` rebajado **y**
la penalidad en `recorded`: `pendingPayouts` recuperaba el viaje más tarde y se
la volvía a descontar. Cobrada dos veces.

Por el mismo motivo, `marcarCobradas` se llama **dentro** del bloque de
transferencia exitosa, nunca antes.

Es la parte que más agradecería un segundo par de ojos.

---

## Archivos tocados

### `backend`

| Archivo | Qué |
|---|---|
| `server/services/cancellationPenalty.ts` | **Nuevo.** Reglas puras: escalera, importe, descuento y la política que se publica |
| `server/services/cancellationPenalty.test.ts` | **Nuevo.** 28 tests |
| `server/services/cancellationPenaltyStore.ts` | **Nuevo.** Guardar, listar pendientes, marcar cobradas |
| `server/db/migrations.ts` | Tabla `driver_cancellation_penalties` + 3 índices |
| `server/api/rides/cancel.ts` | Registra la penalidad en los dos caminos de cancelación del chofer |
| `server/services/ridePayout.ts` | Descuenta de la transferencia y marca las deudas saldadas |
| `server/config/pricing.ts` | Publica la escalera en `getPricingPolicy()` |
| `server/api/admin.ts` | `GET /api/admin/penalties` y `PATCH /api/admin/penalties/:id` |

### App (`urbont`)

| Archivo | Qué |
|---|---|
| `src/services/pricingPolicy.ts` | Lee la escalera de `/api/config` y estima el porcentaje |
| `src/services/pricingPolicy.test.ts` | 6 tests nuevos |
| `src/screens/driver/components/DriverUIHelpers.tsx` | El aviso con el importe en el botón de soltar |
| `src/screens/driver/components/RidesTab.tsx` | Le pasa los datos del viaje al botón |

---

## Detalles que explican por qué el código es así

**`accepted_at` se lee antes de liberar.** El `UPDATE` que suelta la reserva
pone `accepted_at` a `null`. Si la penalidad se calculara después de leer la
fila otra vez, no habría desde cuándo contar los 5 minutos.

**La penalidad se registra después de que la liberación haya ido bien.** Si el
`UPDATE` devuelve 409 porque el estado cambió, no hubo cancelación que penalizar.

**Guardar no interrumpe la cancelación.** Si la base falla al escribir la fila,
el chofer igual suelta la reserva y el pasajero igual recibe otro coche. Dejar a
alguien atrapado en una pantalla porque no se pudo escribir una fila sería peor.
El fallo se registra con `log.error` —es dinero— y el panel lo verá como una
cancelación sin penalidad.

**Se guardan las dos horas, los minutos y el valor, no solo el resultado.** El
panel tiene que poder explicarle al chofer por qué se le cobró eso sin
recalcular nada, y la escalera puede haber cambiado desde la cancelación.

**Una penalidad de $0 también se guarda**, como `waived`. El panel necesita ver
que la cancelación existió y por qué no costó nada, y ese estado hace que el
cobro ni la mire.

**Un viaje a demanda no penaliza.** La política habla de reservas. El segundo
camino de cancelación (`confirmed`/`accepted`) lo comprueba con `scheduled_at`.

**La app no inventa porcentajes.** Si el servidor es antiguo y no publica la
política, `getPenaltyPolicy()` devuelve `null` y el aviso no enseña ninguna
cifra. Enseñar un número inventado sería peor que callar: el chofer decidiría
soltar con un precio que no es el que va a pagar. El importe que vale es
siempre el que devuelve el servidor al cancelar.

---

## Cómo probarlo

```bash
# backend
cd backend && npx vitest run server/services/cancellationPenalty.test.ts
npx tsc --noEmit && npx vitest run     # 625 tests

# app
npx tsc --noEmit && npx vitest run     # 130 tests
```

La migración es idempotente (`CREATE TABLE IF NOT EXISTS` + `safeIndex`) y corre
sola al arrancar el servidor.

---

## Antes de activarlo en producción

Todo va detrás de **`CANCELLATION_PENALTY`**. Con `CANCELLATION_PENALTY=off` no
se calcula ni se guarda nada y el comportamiento es exactamente el de hoy.

Orden sugerido:

1. Desplegar con el flag **apagado**. La migración crea la tabla sin efectos.
2. Montar la pantalla en el panel (`UrbontCompany/panel`, otro repo) con los dos
   endpoints de `admin.ts`. Sin ella nadie puede anular una penalidad injusta.
3. Avisar a los choferes del cambio de condiciones.
4. Encender el flag.

**No encender el flag antes del paso 2.** Si se cobra y no hay dónde disputar,
la única salida es editar filas a mano en la base.

---

## Lo que sigue fuera de alcance

La pantalla del panel. Vive en `UrbontCompany/panel`, que no está en estos dos
repos. Aquí quedan los endpoints y este documento; la pantalla la hace quien
tenga ese repo.
