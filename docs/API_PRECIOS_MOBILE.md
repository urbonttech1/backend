# URBONT API — Precios desde el servidor

> **Para:** el desarrollador de la app móvil (`UrbontApp/urbont`)
> **De:** `urbont-api`
> **Fecha:** 2026-09-09
> **Estado:** implementado, pendiente de desplegar
> **Base:** `https://api.urbont.com`

Referencia de los endpoints de precios que ya están listos, qué devuelven
exactamente, y qué constantes se pueden borrar del APK a partir de ahora.

Todas las respuestas de este documento están **capturadas del servidor en
ejecución**, no escritas a mano. Los importes salen de las tarifas por defecto; si
un admin las cambia desde el panel, los endpoints devuelven los valores nuevos de
inmediato, sin redesplegar.

Auth: `Authorization: Bearer <token>` salvo donde se indique.

---

## 1. Cotizar un viaje

### `GET /api/rides/calculate-fare` — cambia

Cotiza cuando ya tenés la distancia y la duración, por ejemplo mientras el usuario
arrastra el destino en el mapa. No llama a Google, así que es barato y responde
rápido.

#### Por distancia

| Query | Tipo | |
|---|---|---|
| `distanceKm` | number | **obligatorio** |
| `durationMinutes` | number | **obligatorio** |
| `vehicleType` | string | por defecto `sedan` |

```jsonc
// GET /api/rides/calculate-fare?distanceKm=12.87&durationMinutes=20&vehicleType=sedan
{
  "base_fare": 25,           // tarifa mínima, ya con recargo aplicado
  "distance_charge": 19.99,  // millas extra × perMile × recargo
  "time_charge": 5,          // duración × perMin × 0.25 × recargo
  "booking_fee": 2.5,        // fijo, NUNCA lleva recargo
  "ride_fare": 52.49,        // suma de los cuatro anteriores
  "platform_fee": 5.25,      // 10% sobre ride_fare
  "total": 57.74,            // ← lo que paga el pasajero
  "surge_multiplier": 1,     // ← nuevo: mostralo si es > 1
  "distance_miles": 8,
  "extra_miles": 5,
  "included_miles": 3,
  "duration_minutes": 20,
  "currency": "USD"
}
```

#### Por hora — **nuevo**

| Query | Tipo | |
|---|---|---|
| `bookingType` | string | **obligatorio** — literal `hourly` |
| `hours` | number | **obligatorio**, mayor que 0 |
| `vehicleType` | string | por defecto `sedan` |

```jsonc
// GET /api/rides/calculate-fare?bookingType=hourly&hours=4&vehicleType=sedan
{
  "hourly_charge": 440,      // billed_hours × per_hour × recargo
  "booking_fee": 2.5,
  "ride_fare": 442.5,
  "platform_fee": 44.25,
  "total": 486.75,
  "surge_multiplier": 1,
  "billed_hours": 4,         // ← puede ser mayor que requested_hours
  "requested_hours": 4,
  "per_hour": 110,
  "min_hours": 2,
  "currency": "USD"
}
```

> **El bloque mínimo se cobra completo.** Pedir `hours=1` devuelve
> `billed_hours: 2` y cobra las dos. Conviene mostrar ese detalle: si el usuario
> elige una hora y ve el precio de dos sin explicación, parece un error.

---

### `GET /api/rides/estimate` — cambia

Cotiza a partir de coordenadas: calcula la ruta real con Google Directions y valida
el área de servicio. Más caro que el anterior — usalo al confirmar, no en cada
arrastre del mapa.

| Query | Tipo | |
|---|---|---|
| `pickupLat` · `pickupLng` | number | **obligatorio** |
| `dropoffLat` · `dropoffLng` | number | **obligatorio** |
| `vehicleType` | string | por defecto `standard` |
| `stops` | JSON | opcional — `[{lat,lng}]` |

```jsonc
{
  "base_fare": 25,
  "distance_charge": 27.15,
  "time_charge": 5.8,
  "booking_fee": 2.5,
  "ride_fare": 60.45,
  "platform_fee": 6.05,
  "total": 66.5,
  "surge_multiplier": 1,
  "distance_miles": 9.79,
  "extra_miles": 6.79,
  "included_miles": 3,
  "duration_minutes": 23.2,
  "currency": "USD",
  "distanceMiles": 9.787839020122485,  // duplicados heredados:
  "durationMinutes": 23.2              // usá los snake_case
}
```

Sigue devolviendo el geofence como antes: `422 { "error": "outside_service_area" }`.

> ⚠️ **Sigue devolviendo una sola clase de vehículo.** El array `options[]` con las
> tres clases que pedían en su §6.1 **todavía no está**. Por ahora, una llamada por
> clase, o usá `calculate-fare` tres veces, que no consume cuota de Google.

---

## 2. Crear el viaje

### `POST /api/rides` — cambia

Tres cosas cambiaron, y las tres afectan el precio final.

#### 2.1 El recargo lo decide el servidor

Si mandan `surgeMultiplier`, se toma el **menor** entre el suyo y el del servidor.
Nunca se cobra por encima de lo que mostraron en pantalla. Cuando dejen de
calcularlo y usen el de `/estimate`, ambos valores coinciden y ese mínimo deja de
tener efecto.

#### 2.2 Las reservas por hora ya se cotizan en el servidor

```jsonc
{
  "booking_type": "hourly",
  "hourly_hours": 4,
  "vehicleType": "sedan"
  // ...el resto de campos del viaje
}
```

Con esos dos campos el servidor cobra por bloque de horas en vez de por distancia.
Antes guardaba `hourly_hours` y no lo usaba para nada: el precio era el que mandara
el cliente.

#### 2.3 El `fare` que manden se recalcula

Si el cuerpo incluye `distanceMiles` y `durationMinutes`, el servidor recalcula el
precio y **sobrescribe** el `fare` recibido. Es la fuente de verdad; el suyo se usa
sólo como referencia.

> 🔴 **Esto va a endurecerse.** Hoy, si el cuerpo *omite* esos dos campos, no hay
> recálculo y sólo se rechaza un `fare` menor a $3.00. Vamos a cerrar ese hueco
> haciendo que el servidor calcule la distancia por su cuenta.
>
> **Lo haremos después de que la app consuma `/estimate`**, para no dejar sin
> reservar a los APK viejos. Avisamos antes.

---

## 3. Endpoints que estaban rotos

Estos tres fallaban por columnas que el código consultaba y que nunca se crearon en
la base. **No hace falta cambiar nada del lado de la app**: la firma es la misma,
sólo que ahora responden.

### `GET /api/rides/driver-history` — arreglado

Devolvía **400** siempre: el `SELECT` incluía `driver_earnings`, que no existía. El
historial del chofer no cargaba nunca. Ahora responde 200 y ese campo trae lo que le
corresponde al chofer por cada viaje.

### `POST /api/rides/:id/long-pickup-fee` — arreglado

Mismo caso con `long_pickup_fee`. La compensación por recogida larga no se podía
cobrar.

### `GET /api/rides/:id/public` — arreglado

Seguimiento sin autenticación, para compartir un viaje por link. Daba **500**. Ahora
responde, y la posición del chofer sale de `driver_locations` —la tabla en vivo—
descartando lecturas de más de 5 minutos.

```jsonc
{
  "status": "in_progress",
  "driverName": "Carlos Urbont",
  "vehicleModel": "Cadillac Escalade",
  "vehiclePlate": "TEST-1",
  "pickup": "...",
  "dropoff": "...",
  "driverLat": 25.7617,   // sólo si hay posición reciente
  "driverLng": -80.1918
}
```

---

## 4. Clases de vehículo

El servidor normaliza los nombres, así que los que ya manda la app siguen
funcionando. Para código nuevo conviene usar la clave canónica.

| Canónica | Alias aceptados | Tarifa mínima | Por hora |
|---|---|---|---|
| `sedan` | `business class` · `executive` · `standard` | $25.00 | $110.00 |
| `suv` | `premium suv` · `premier` · `luxury` | $38.00 | $145.00 |
| `van` | `van & sprinter` · `sprinter` · `max` | $65.00 | $185.00 |

Un `vehicleType` desconocido devuelve `400 {"error": "Unknown vehicleType: …"}`.

Los valores de la tabla son los actuales: un admin puede cambiarlos desde el panel y
los endpoints devuelven los nuevos de inmediato.

---

## 5. Qué pueden borrar del APK

### ✅ Ya cubierto por el servidor

| Constante | Reemplazo |
|---|---|
| `FARE_RULES` y las fórmulas de distancia | `calculate-fare` y `estimate`, que devuelven el desglose completo |
| `HOURLY_RATES` y `calculateHourlyFareBreakdown` | `bookingType=hourly` — era lo que bloqueaba su fase 6 |
| `getDynamicMultiplier()` y la tabla de franjas | `surge_multiplier`, decidido con la hora de Miami en vez del reloj del dispositivo |
| `BOOKING_FEE` y `SCHEDULING_FEE` | Vienen dentro de `booking_fee`, ya sumados según el tipo de reserva |

### ❌ Todavía no

| Constante | Por qué |
|---|---|
| Las 3 constantes de comisión | `driver_payout` y `commission_amount` aún no llegan en el payload del viaje. Hasta entonces, `IncomingRequestModal` y `payments.ts` siguen necesitando su 10% |
| `FREE_WAIT_MINUTES` · `WAIT_TIME_FEE_PER_MIN` | No están en `/api/config` aún. Manténganlos como fallback, tal como plantearon en su fase 3 |

---

## 6. Lo que falta de nuestro lado

| Pendiente | Bloquea |
|---|---|
| `options[]` en `/estimate` | Mostrar las tres clases con una sola llamada |
| `driver_payout` y `commission_amount` en `GET /api/rides/:id` y `ride:new_request` | Borrar las 3 constantes de comisión del APK |
| `wait_free_minutes`, `wait_fee_per_min`, `valet_fee` en `/api/config` | Borrar los valores de espera del APK |
| Definir qué es `SERVICE_FEE = 5` | No existe nada equivalente en el backend; necesitamos saber qué cobra |

### Dos avisos sueltos

**`min_version` está hoy en `1.0.0`**, no en `1.2.0` como figura en su documento. Si
cuentan con esa red de seguridad, hay que subirla a mano.

**Sobre su §A.5:** el 10% no se cobra dos veces. Sobre un `ride_fare` de $100, el
pasajero paga $110 y el chofer recibe $99 — margen efectivo **11%, no 20%**. El
`fare` que reciben en el payload **es el total**, con el platform fee incluido.

---

## 7. Reglas del cálculo

Por si necesitan replicar algún número para verificarlo:

- El recargo por demanda multiplica **tarifa mínima, distancia y espera**. Nunca el
  cargo de reserva ni el de programación.
- La comisión del 10% se calcula sobre el subtotal **ya recargado**.
- El redondeo a dos decimales se aplica **en cada paso**, no sólo al final — como
  bien anotaron en su anexo. El orden cambia el centavo.
- La espera se cobra al 25% de la duración estimada del viaje: es el factor `× 0.25`
  que aparecía sin explicar en su código. Se mantuvo idéntico para no mover ningún
  precio.

El código de referencia está en `server/config/pricing.ts`, y los tests que fijan
estas reglas en `server/config/pricing.test.ts`.
