# Penalidad al chofer que cancela una reserva

> Estado: **fase 1 de 6 hecha**. El cálculo existe y está probado, pero nadie lo
> llama todavía: no guarda, no cobra y no cambia el comportamiento en producción.
>
> Rama `feat/backend-cancellation-penalty` · commit `e9e302e` · 18 de octubre de 2026

---

## El problema

Soltar una reserva ya aceptada sale gratis. `rides/cancel.ts` la devuelve al
pool, se la ofrece a otros choferes y nadie paga nada. Un chofer puede tomar una
reserva para asegurarse el hueco y soltarla media hora antes del servicio sin
coste, dejando al pasajero sin coche y al dispatcher buscando reemplazo a mano.

La política acordada: al aceptar, el chofer asume el servicio. Si lo suelta,
paga un porcentaje del valor de la reserva que crece según se acerca la hora.

## La escalera

| Momento de la cancelación | Penalidad |
|---|---|
| Dentro de los 5 min desde que aceptó | 0 % |
| Pasados los 5 min, falta más de 2 h | 20 % |
| Falta más de 1 h, hasta 2 h | 40 % |
| Falta más de 30 min, hasta 1 h | 60 % |
| Falta 30 min o menos (o la hora ya pasó) | 100 % |

Sobre una reserva de $100: $0 · $20 · $40 · $60 · $100.

---

## Lo que ya estaba hecho antes de empezar

Conviene saberlo para no reconstruirlo:

| Pieza | Dónde |
|---|---|
| `accepted_at`, `scheduled_at`, `locked_fare`, `driver_id`, `ride_status` | `rides`, ya pobladas |
| Se escribe `accepted_at` al tomar una reserva | `services/scheduledOffer.ts:162` |
| Quién puede cancelar, decidido en el servidor | `services/cancelActor.ts` |
| Historial de eventos del chofer, con índice único antiduplicado | `driver_ride_events` |
| Liberación de la reserva al pool y reoferta | `api/rides/cancel.ts:101` |
| Cargo por cancelación **al pasajero** (otra escalera, no tocar) | `calcularCancelacionReserva` en `config/pricing.ts` |
| Canal que publica políticas a la app | `getPricingPolicy()` → `/api/config` |
| Alarmas al panel | patrón de `services/reservationConfirm.ts` |

---

## Fase 1 — hecha

**`server/services/cancellationPenalty.ts`** y su `.test.ts`. Reglas puras, sin
base de datos ni Stripe, al estilo de `reservationConfirm.ts`.

- `porcentajePenalidad(cancelacion)` — el tramo, el motivo y los minutos
  restantes y transcurridos (el panel los necesita).
- `calcularPenalidad(cancelacion, valorReserva)` — el importe, redondeado a dos
  decimales.
- `politicaDePenalidad()` — la escalera serializada, para publicarla a la app.
- `penalizacionActiva()` — flag `CANCELLATION_PENALTY=off`.

Decisiones de diseño que conviene respetar:

- **Sin fechas válidas no se cobra.** Cobrar de más por un dato corrupto es peor
  que no cobrar. Devuelve motivo `sin_datos`.
- **Una cancelación anterior a la aceptación** es un reloj roto, no un chofer
  rapidísimo: tampoco cobra.
- El **motivo** (`exento_5_min`, `mas_de_2_h`, …) se guarda con la penalidad para
  que el panel explique el porqué sin recalcular nada.

21 tests. La suite del backend quedó en **618 pasando** (antes 597), typecheck limpio.

---

## Las dos decisiones que se tomaron sin confirmar

Las dos están pendientes del visto bueno de Paulo. Ninguna bloquea seguir, pero
**las dos son dinero real cobrado a un chofer**.

### 1. El corte del 100 % se puso en 30 minutos

La tabla original se contradecía: la fila «falta 1 hora o menos, pero más de 0
minutos → 60 %» y la fila «falta menos de 1 hora → 100 %» cubren el mismo tramo.
Tal como estaba escrito, el 60 % solo habría existido en el instante exacto de
60:00 minutos, o el 100 % no se habría aplicado nunca, según el orden de los `if`.

Los ejemplos de la propia política sí resuelven el solape: a 1 h cobra $60 y a
30 min cobra $100. De ahí sale el corte en 30 minutos.

**Vive en una sola constante: `TRAMO_INMINENTE_MINUTOS`.** Cambiarla a 45 o a 20
es cambiar ese número y dos asserts del test.

### 2. La exención de 5 minutos manda sobre el tiempo restante

Es lo que dice la política, literalmente. Tiene un efecto conocido y aceptado por
ahora: **aceptar una reserva que empieza en 20 minutos y soltarla a los 2 sale
gratis** — justo el caso que más daño hace.

Hay un test que lo fija explícitamente, para que el día que se cambie el test
avise de que se está cambiando algo intencionado, no arreglando un descuido.

La corrección, si se decide: que la exención no aplique cuando falte menos de 1 h.

---

## Lo que queda pendiente

### Fase 2 — Persistencia

Migración idempotente en `server/db/migrations.ts`, con `safeAlter`, al estilo
del resto del archivo. Tabla `driver_cancellation_penalties`:

- reserva, chofer, `accepted_at`, `cancelled_at`, minutos restantes al cancelar
- porcentaje, importe, motivo
- estado: `pending` · `recorded` · `charged` · `disputed` · `waived`
- **índice único `(ride_id, driver_id)`** — es el antídoto contra el doble cobro
  que pide el punto 6 de la política, igual que el de `driver_ride_events`.

### Fase 3 — Enganche

Dentro del bloque que ya existe en `api/rides/cancel.ts:101`, el que libera la
reserva. Calcular, guardar y emitir la alarma al panel.

**No cambiar lo que ese bloque ya hace:** la reserva se sigue reofreciendo a
otros choferes y el pasajero sigue sin pagar nada. La penalidad se añade encima.

Base del cálculo: `locked_fare ?? fare`, como el resto del archivo.

Una reasignación del sistema (`reassigned`) **no** penaliza; solo
`driver_cancelled`. La distinción ya existe en `driver_ride_events`.

### Fase 4 — API

- Añadir `politicaDePenalidad()` a `getPricingPolicy()`. Con eso viaja sola a la
  app por `/api/config` y no hace falta endpoint nuevo para el aviso al chofer.
- `GET /api/admin/penalties` con filtros, y detalle por chofer.
- `PATCH /api/admin/penalties/:id` para `disputed` y `waived`.

### Fase 5 — App (repo `urbont`, no este)

- **Antes de aceptar:** mostrar las condiciones en la tarjeta de reserva,
  leyendo la política de `/api/config`. Nada de porcentajes escritos a mano.
- **Al soltar:** `ReleaseReservationButton` en
  `src/screens/driver/components/DriverUIHelpers.tsx:398` hoy solo dice *"the
  passenger won't be charged"*. Debe decir cuánto le va a costar a él, con el
  importe calculado en el servidor, antes de confirmar.
- Traducciones en `en`, `es`, `fr`, `pt`.

### Fase 6 — Cobro efectivo

Descontar las penalidades `recorded` de las ganancias pendientes, en
`services/pendingPayouts.ts`.

**Es la fase con riesgo real sobre dinero.** Dejarla para el final, detrás del
flag, y solo cuando el panel ya muestre los estados y se puedan anular a mano.

Hoy existe toda la maquinaria para *pagar* al chofer (`driverBalance.ts`,
`pendingPayouts.ts`, `payoutRecovery.ts`) y **ninguna para cobrarle**. Un débito
directo contra Stripe Connect es otra liga y quedó descartado de momento.

---

## Fuera de alcance

La pantalla del panel (punto 5 de la política) vive en el repo
`UrbontCompany/panel`, que no está en esta máquina. Este repo entrega los
endpoints de la fase 4 y su contrato; la pantalla la hace quien tenga ese repo.

---

## Para retomar

1. Confirmar con Paulo las dos decisiones de arriba.
2. Seguir por la fase 2, que no depende de nada más.
3. Las fases 1–4 son backend puro y se pueden probar con tests sin tocar la app.
   La 5 va después; la 6, la última.
