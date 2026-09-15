# Plan — Tarifas del cliente (backend, panel y app)

> **Para:** backend (`urbont-api`), panel (`panelv2`) y app móvil (`app`)
> **Fuente:** [`relacion_tarifas.odt`](relacion_tarifas.odt) y las respuestas del cliente
> **Fecha:** 2026-09-15
> **Estado:** ✅ implementado en backend y panel — pendiente de desplegar · la app la
> actualiza su propio equipo (sección 4)
>
> ## Resultado de la implementación
>
> | Repo | Verificación |
> |---|---|
> | `urbont-api` | `tsc` limpio · tests en verde, incluidos los casos de la sección 6 |
> | `panelv2` | `tsc` limpio · 44 tests (11 nuevos en `src/lib/fares.test.ts`) |
> | `app` | **No se toca desde aquí.** Los cambios de la sección 4 los hace el equipo de la app; el detalle, en `API_PRECIOS_MOBILE.md` §7 |
>
> **Ajustes respecto al plan, decididos al implementar:**
>
> - **Tarifa por hora:** la reserva también sólo se cobra si es programado. Antes
>   sumaba $2.50 siempre; un servicio por horas a demanda baja de $486.75 a $484.
> - **Espera por minutos enteros:** se cobra el minuto completo, no fracciones.
> - **No-show exige llegada marcada.** Antes, sin `wait_started_at`, se podía marcar
>   sin haber esperado nada.
> - **Tramos robustos:** la regla de «nunca menos que el tramo anterior» se aplica en
>   los dos límites (3 y 10 mi), así que el precio no baja con la distancia aunque se
>   carguen tarifas decrecientes desde el panel.
> - **Políticas en el panel:** llegan con `GET /api/admin/fares` (`pricingPolicy`),
>   además de en `GET /api/config`. Así la pantalla no depende del proxy.
> - **App, fuera de nuestro alcance:** además de lo de la sección 4, `TrackingScreen`,
>   `ConfirmedScreen` y `DriverModeReimagined` tienen las reglas viejas fijas en
>   pantalla ($0.50/min sin tope, «$10 no-show fee», 2 min de cancelación gratis). Se
>   documentan para el equipo de la app en `API_PRECIOS_MOBILE.md` §7; el repo de la
>   app no se modifica desde aquí.
> - **Pago al chofer** extraído a `server/services/ridePayout.ts`, que usan el cierre
>   del viaje y el no-show de reservas.
>
> Sigue abierto el **supuesto** de la sección 1: el chofer no recibe nada cuando el
> pasajero cancela una reserva.

## Contexto

`docs/relacion_tarifas.odt` define las tarifas que debe cobrar URBONT. Al contrastarlo
con el código, solo coincidían el 10 % de plataforma y los 5 minutos de espera gratis.
Hoy la app cobra entre un 9 % y un 100 % más que el documento. En producción no hay
`fares_config`, así que rigen los valores por defecto de `server/config/pricing.ts`.

Parte del cambio son valores y parte es lógica que hoy no existe:

- Tramos por milla.
- Espera por clase.
- Fórmula de no-show.
- Cancelación de reservas: la regla está escrita en el código, pero nunca se llama.
- Exención de los viajes de valet.

El panel no permite editar los tramos ni la espera.

**Objetivo:** cobrar exactamente lo acordado, que los precios por clase se editen desde
el panel y que la app actual no se rompa.

---

## 1. Valores y reglas acordados con el cliente

### Tarifa por clase

| | Sedan | SUV | Van |
|---|---|---|---|
| Tarifa mínima | $17 | $22 | $27 |
| Por milla, viaje de hasta 3 mi | $2.90 | $3.50 | $3.75 |
| Por milla, viaje de más de 3 y hasta 10 mi | $3.00 | $3.50 | $4.00 |
| Por milla, viaje de más de 10 mi | $2.50 | $3.00 | $3.50 |
| Espera por minuto | $0.75 | $1.00 | $1.25 |
| Reserva (solo viajes programados) | $10 | $15 | $20 |
| Por minuto de trayecto, por hora y horas mínimas | sin cambios | | |

### Fórmula de un viaje por distancia

1. **Distancia:** millas × tarifa del tramo al que pertenece el viaje completo. Por
   ejemplo, un viaje de 10,5 mi va entero a la tarifa de más de 10 mi. Si el viaje pasa
   de 10 mi, este importe nunca baja de 10 × tarifa del tramo de 3 a 10 mi. Así, 11 mi
   nunca cuestan menos que 10.
2. **Base:** lo que sea mayor entre la tarifa mínima y la distancia.
3. **Tiempo:** duración × tarifa por minuto × 0,25. Se mantiene igual que hoy.
4. **Recargo por demanda:** multiplica la base y el tiempo, pero no la reserva. Se
   mantiene.
5. **Reserva:** solo se suma en viajes programados. Desaparecen los $2,50 que hoy paga
   todo viaje y los $5 extra de los programados.
6. **Total:** (base + tiempo + reserva) + 10 %.

Se mantienen también el cargo de $5 por recogida lejana y el cobro en USD, incluido
Barranquilla.

### Espera, no-show y cancelación

| Regla | Valor |
|---|---|
| Espera | 5 min gratis; después, la tarifa de la clase, con un **tope de 10 min** cobrables |
| Espera en viajes programados | Cuenta desde la hora de la reserva, aunque el chofer llegue antes |
| No-show en viaje a demanda | Tras 5 + 10 min: `10 × espera por minuto + 10 % del total del viaje` |
| No-show en viaje programado | A los 30 min de la hora reservada: se cobra el 100 % y el chofer cobra lo acordado |
| Pasajero cancela un viaje a demanda | **Gratis** (se quita el cargo de $10). El chofer no recibe nada |
| Pasajero cancela un viaje programado | 2 h o más antes: gratis · entre 2 h y 1 h: 50 % · menos de 1 h: 100 % |
| Viajes de valet | Sin cargos de espera, no-show ni cancelación |

> **Supuesto:** cuando el pasajero cancela una reserva, el chofer tampoco recibe nada,
> igual que en los viajes a demanda. El cliente solo lo confirmó para los viajes a
> demanda.

---

## 2. Backend — `urbont-api`

### 2.1 Motor de precio — `server/config/pricing.ts`

- En `FareClass`, añadir `perMileTier1`, `perMileTier2`, `perMileTier3` y
  `waitPerMin`.
  - `serviceFee` pasa a ser la reserva de los viajes programados; se conserva el
    nombre.
  - `includedMiles`, `perMile` y `cancellationFee` dejan de usarse.
- Actualizar `DEFAULT_FARE_CLASSES` con los valores de la tabla de la sección 1.
- Cambiar `calculateFareFromRules` a la fórmula nueva, **sin cambiar la forma de la
  respuesta**:
  - `base_fare` pasa a ser la tarifa mínima.
  - `distance_charge` pasa a ser lo que la distancia supera a la mínima.
  - Así, la suma de los componentes sigue dando el total.
  - Se añaden los campos `per_mile` y `tier`.
- Añadir funciones puras:
  - `calcularCargoEspera(clase, minutos)`
  - `calcularNoShowDemanda(clase, totalViaje)`
  - `calcularCancelacionReserva(horasAntes, total)`
- Definir como constantes: 5 min gratis, tope de 10, 10 min de no-show, 30 min en
  reservas, y los umbrales de 2 h y 1 h.

### 2.2 Carga y edición

- `server/services/fareConfig.ts` → `normalizeClass`: leer los campos nuevos. Si solo
  llega el `perMile` antiguo, usarlo en los tres tramos.
- `server/api/admin.ts` → `PUT /fares`:
  - Lista `allowed`: añadir `perMileTier1`, `perMileTier2`, `perMileTier3` y
    `waitPerMin`.
  - Quitar `includedMiles`, `perMile` y `cancellationFee`, que pasan a devolverse en
    `rejected`. Así, un panel sin actualizar no puede sobrescribir los tramos.

### 2.3 Crear y cotizar — `server/api/rides/create.ts`

- `GET /calculate-fare` y `GET /estimate`: respetar `bookingType=scheduled`. La app ya
  lo envía.
- `POST /api/rides`: decidir la reserva según `scheduled_at` en el servidor, sin fiarse
  del `booking_type` que manda el cliente.
- Borrar `calculateCancellationFee`: es código muerto y la reemplaza la función de
  `pricing.ts`.
- `server/api/rides/checkin.ts` (cambio de destino): indicar si el viaje es programado
  al recalcular, para que no se pierda la reserva.

### 2.4 Espera al completar — `server/api/rides/status.ts`

- Usar `calcularCargoEspera` con la clase del viaje. Sustituye a
  `WAIT_TIME_FEE_PER_MIN` y al tope de 60 min.
- En viajes programados, contar la espera desde el mayor entre `wait_started_at` y
  `scheduled_at`.
- No cobrar espera si el viaje tiene `dispatched_by_valet`.
- Extraer a una función el bloque que captura el pago y transfiere el 90 % al chofer.
  Hoy usa `calculateRideMetrics`, de `server/services/rideMetrics.ts`.

### 2.5 Cancelación y no-show — `server/api/rides/cancel.ts`

- **Pasajero, viaje a demanda:** quitar la ventana de 2 min y los $10. Se libera el
  cobro retenido completo.
- **Pasajero, viaje programado:** aplicar `calcularCancelacionReserva` según
  `scheduled_at`, **sea cual sea el estado del viaje**.
- **`/:id/no-show`:**
  - A demanda: exigir 15 min desde `wait_started_at` y cobrar `calcularNoShowDemanda`.
  - Programado: exigir 30 min desde `scheduled_at`, cobrar el 100 % y pagar al chofer
    con la función de captura extraída en el punto 2.4.
- **Valet:** sin cargos en ningún caso.

### 2.6 Publicar las políticas — `server/api/config.ts`

`GET /api/config` devuelve `pricingPolicy` con:

- minutos de espera gratis y tope cobrable;
- minutos para el no-show a demanda y en reservas;
- umbrales de cancelación de reservas.

Así, el panel y la app los muestran sin llevarlos escritos en su código.

---

## 3. Panel admin — `panelv2/src/app/(dashboard)/fares/page.tsx`

La pantalla ya lee y guarda con `adminFetch('/fares')`, y avisa de los campos que el
servidor rechaza. Hay que cambiar los campos, las etiquetas y la vista previa. Ninguna
otra pantalla del panel muestra valores de espera o cancelación.

### 3.1 Campos

- Tipo `FareConfig`: añadir `perMileTier1`, `perMileTier2`, `perMileTier3` y
  `waitPerMin`; quitar `includedMiles`, `perMile` y `cancellationFee`.
- **Tarifa por distancia** (`DISTANCE_FIELDS`):

  | Campo | Etiqueta | Descripción |
  |---|---|---|
  | `minFare` | Tarifa mínima | Lo mínimo que cuesta cualquier viaje |
  | `perMileTier1` | Por milla · viaje de hasta 3 mi | |
  | `perMileTier2` | Por milla · viaje de 3 a 10 mi | |
  | `perMileTier3` | Por milla · viaje de más de 10 mi | Se aplica al viaje completo según su distancia total |
  | `perMin` | Por minuto de trayecto | Tráfico, 25 % de la duración |

- **Grupo nuevo, Espera:** `waitPerMin`, «Espera por minuto — tras 5 min gratis, con
  un tope de 10».
- **Cargos fijos** (`FEE_FIELDS`):
  - `serviceFee` pasa a llamarse «Reserva», con la descripción «Solo viajes
    programados; sin recargo».
  - Quitar `cancellationFee`.
- **Tarifa por hora:** sin cambios.

### 3.2 Vista previa

- Mover la estimación a `panelv2/src/lib/fares.ts` como espejo exacto de la fórmula
  nueva: tramo por distancia total, tope de 10 millas, máximo con la mínima, tiempo, y
  la reserva solo en viajes programados.
- Añadir un selector **A demanda / Programado** para simular la reserva.
- Escenarios: corto (2 mi, 8 min), medio (8 mi, 20 min), largo (20 mi, 45 min) y una
  comprobación de 10 mi frente a 11 mi.

### 3.3 Bloque «Políticas», solo lectura

Leer `pricingPolicy` de `/api/config` y mostrar la espera gratis, el tope, el no-show y
las cancelaciones. Se deja claro que se cambian en código, no desde el panel.

### 3.4 Tests

Crear `panelv2/src/lib/fares.test.ts` con los mismos casos que el backend, para que la
vista previa no se aparte de lo que realmente se cobra.

---

## 4. App móvil — `app/`

La app ya pide precios al servidor y envía `bookingType=scheduled`. Estos cambios no
bloquean el despliegue.

- `src/screens/booking/utils.ts`: la tabla de respaldo local (`FARE_RULES`,
  `BOOKING_FEE`, `SCHEDULING_FEE`) tiene los precios viejos y se usa si el servidor
  falla. Hay que actualizarla a la fórmula y los valores nuevos.
- `src/services/fare.ts` → `mapDistanceQuote`: leer `per_mile` y `tier` del servidor
  en vez de calcular `distance_charge / extra_miles`, que con tramos da un valor
  incorrecto.
- Los textos de espera y cancelación deben salir de `pricingPolicy`.

---

## 5. Despliegue sin afectar al usuario

1. **Backend primero.**
   - La respuesta mantiene su forma.
   - Los viajes ya creados conservan su precio, congelado en `locked_fare`.
   - Los precios nuevos rigen desde ese momento: conviene fijar la fecha con el
     cliente.
2. **Panel el mismo día.** Mientras no se actualice, si alguien guarda los campos
   viejos, el servidor los rechaza y la pantalla ya muestra el aviso.
3. **App después.** Hasta que se actualice, lo único que puede verse desfasado es el
   «por milla» mostrado y el precio de respaldo cuando no hay red.

## 6. Verificación

**Backend** — `server/config/pricing.test.ts`: reescribir los casos con valores viejos
y añadir estos:

| Caso | Resultado esperado |
|---|---|
| Sedan, 2 mi, 8 min, a demanda | $20.90 (aplica la mínima) |
| Sedan, 8 mi, 20 min, a demanda | $31.90 |
| Van, 20 mi, 40 min, a demanda | $96.25 |
| Sedan, 10 mi y 11 mi | **Mismo total** |
| De 0 a 30 mi en pasos de 0,1, por clase | El precio nunca baja al aumentar la distancia |
| Viaje programado | Suma la reserva, sin recargo |
| Espera de 3, 5, 12 y 30 min | $0 · $0 · 7 min · tope de 10 min |
| Cancelación a 2 h 01, 1 h 59, 1 h 00 y 0 h 59 | 0 % · 50 % · 50 % · 100 % |
| No-show de sedan con un viaje de $31.90 | $10.69 |
| Viaje de valet | $0 de espera y $0 de no-show |

Comandos: `npx tsc --noEmit` y `npx vitest run` en `urbont-api`.

**Panel:** `fares.test.ts` con los mismos casos, y compilar `panelv2`.

**Prueba de punta a punta:**

1. Editar un tramo desde el panel.
2. Comprobar que `GET /api/rides/calculate-fare` refleja el cambio al instante, con y
   sin `bookingType=scheduled`.
3. Comprobar que la vista previa del panel muestra el mismo total.
