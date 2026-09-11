# URBONT API — Geocerca, tarifa y conducción

> **Para:** el desarrollador de la app móvil (`UrbontApp/urbont`)
> **De:** `urbont-api`
> **Fecha:** 2026-09-11
> **Base:** `https://api.urbont.com`
> **Complementa:** [`API_PRECIOS_MOBILE.md`](API_PRECIOS_MOBILE.md) (desglose de precios),
> [`ZONAS_DE_SERVICIO.md`](ZONAS_DE_SERVICIO.md) (cómo funciona la geocerca por dentro) y
> [`GEOCERCA_INTERNACIONAL.md`](GEOCERCA_INTERNACIONAL.md) (qué falta para cobrar fuera de EE. UU.)

Los tres bloques que la app necesita conectar: **dónde se puede pedir un viaje**
(geocerca), **cuánto cuesta** (tarifa) y **el ciclo completo del conductor**
(conducción). Todo lo de aquí sale del código en `server/`, con la ruta y la línea
cuando conviene verificarlo.

> **Lo más importante de esta versión:** ya hay **dos zonas activas en dos países**
> —Miami y Barranquilla—, y eso cambia dos cosas para la app: hay que **mandar
> `lat`/`lng` en las búsquedas de direcciones** (§1.3), y el tarifario sigue siendo
> único y en dólares para las dos ciudades (§1.2).

---

## 0. Lo común a todo

### Autenticación

```http
Authorization: Bearer <supabase_access_token>
```

El middleware es `requireSupabaseAuth` y deja en la petición el `uid` y el **rol**.
El rol decide casi todo lo de la sección de conducción, y hay una trampa: el
sistema distingue `driver` de `chauffeur`, y **no todos los endpoints aceptan
los dos** (ver §3.10).

Sin token: `401`. Con token válido pero rol equivocado: `403`.

### Endpoints públicos (sin token)

| Endpoint | Para qué |
|---|---|
| `GET /api/config` | Mantenimiento, versión mínima, recargo, claves públicas |
| `GET /api/config/surge` | Recargo vigente y su motivo |
| `GET /api/drivers/available-counts` | Conductores en línea por categoría |
| `GET /api/geocode/*` | Autocompletado, geocodificación, direcciones |
| `GET /api/rides/:id/public` | Seguimiento por link compartido |

### Límites de tasa

| Ámbito | Límite |
|---|---|
| Todo `/api` | 150 peticiones / minuto |
| `POST /api/drivers/location` | **30 peticiones / 10 s** |
| `/api/otp`, `/api/chauffeur/login`, `/api/valet/login` | 20 / minuto |

Al pasarse: `429 { "error": "..." }` con cabeceras `RateLimit-*`. El de ubicación
permite una posición cada ~333 ms; con enviar una cada 3–5 s sobra.

### Socket.IO

```ts
io(BASE_URL, {
  transports: ['websocket', 'polling'],
  auth: {
    token: supabaseAccessToken,   // se verifica con SUPABASE_JWT_SECRET
    userId: uid,                  // obligatorio para entrar a las salas
    role: 'chauffeur',            // 'passenger' | 'driver' | 'chauffeur' | 'admin'
    vehicleCategory: 'suv',       // sólo conductores
  },
})
```

`pingInterval` 10 s, `pingTimeout` 30 s. El token que no verifica **no corta la
conexión** (compatibilidad con APK viejos), sólo queda marcada como no verificada
— no te confíes de eso, va a endurecerse.

Al conectar con `userId` el socket entra solo a `user:<uid>`, y si el rol es de
conductor también a `driver:<uid>`.

---

## 1. Geocerca

### Lo primero: la app no tiene que saber dónde opera URBONT

**No hay ningún endpoint que devuelva la geocerca al móvil, y es a propósito.** La
zona vive en la tabla `service_zones`, un admin la cambia desde el panel y aplica
al instante en el servidor (`server/services/serviceZones.ts`). Si el APK llevara
una copia —un centro y un radio en constantes— cada ajuste del panel exigiría un
despliegue de la app y, hasta entonces, la app y el servidor discreparían sobre
qué se puede pedir.

El contrato es al revés: **la app pregunta y reacciona a un 422**.

> Si en el APK quedan constantes de geocerca (centro de Miami, radio en km,
> `isInServiceArea`), se pueden borrar: el servidor las cubre y la app no puede
> mantenerlas al día.

### 1.1 El único contrato: `422 outside_service_area`

Se valida en `GET /api/rides/estimate` y en `POST /api/rides`, sobre origen y
destino:

```jsonc
// 422 — origen fuera
{
  "error": "outside_service_area",
  "message": "We're not available in your area yet. URBONT currently operates within the Greater Miami area. We'd love to serve you soon!"
}

// 422 — destino fuera
{
  "error": "outside_service_area",
  "message": "Your destination is outside our current service area. URBONT operates within the Greater Miami area. We'd love to expand soon!"
}
```

Cómo tratarlo en la app:

- **Discriminá por `message`, no por `error`.** La clave es idéntica en los dos
  casos; el texto es lo único que dice si el problema es el origen o el destino.
  Si querés mostrar mensajes propios o traducidos, lo razonable es no depender del
  texto: pedí que añadamos un campo `field: "pickup" | "dropoff"`. Decinos y lo
  agregamos, es una línea.
- El texto que llega está en inglés y menciona Miami — **también cuando el
  pasajero está en Barranquilla**. Si la app está localizada, usá tu propia copia.
- Un `422` **no es un error de red**: no reintentes, es una respuesta de negocio.

### 1.2 Cómo se comporta hoy, con precisión

| Pregunta | Respuesta de hoy |
|---|---|
| ¿Qué forma tiene la zona? | Círculo: centro + radio. Los polígonos están modelados pero no activos |
| ¿Cuántas zonas hay activas? | **Dos, en dos países:** `miami` (US, radio 170 km) y `barranquilla` (CO, radio 50 km) |
| ¿Origen y destino tienen que estar en la **misma** zona? | 🔴 **No se comprueba, y con dos zonas ya importa.** Cada extremo se valida contra *cualquier* zona activa, así que un viaje Miami→Barranquilla pasa el control de geocerca. `/estimate` lo frena por otra vía —Google no encuentra ruta en coche—, pero `POST /api/rides` no consulta rutas y lo aceptaría. Pendiente de nuestro lado |
| ¿La tarifa cambia según el país? | **No.** Un solo tarifario, en **USD**, y el recargo por franja horaria se calcula con la hora de Miami (`America/New_York`) también para Barranquilla. `service_zones` todavía no tiene columna `currency`. El detalle está en [`GEOCERCA_INTERNACIONAL.md`](GEOCERCA_INTERNACIONAL.md) |
| ¿Se reevalúa durante el viaje? | No. La zona se congela en `rides.zone_id` al crear el viaje, junto al precio |
| ¿Cada cuánto ve la app un cambio de zona? | Inmediato: el servidor relee al guardar y, de respaldo, cada 5 minutos por instancia |
| ¿Qué pasa si la base no responde? | Se mantiene la última zona conocida, o la de Miami por defecto. Nunca deja la app sin poder reservar |

### 1.3 La búsqueda de direcciones ya viene sesgada al área

El centro, el radio, la caja **y el país** con que se busca una dirección salen de
las zonas activas (`getSearchBias()`); la app no manda ninguno de los cuatro.

> **Mandá siempre `lat`/`lng` cuando tengas el GPS.** No es opcional en la
> práctica: con las coordenadas del pasajero el servidor resuelve **su** zona y de
> ahí saca el país y el círculo de búsqueda. Sin ellas, el sesgo cae al de la zona
> más grande —hoy Miami— y los resultados son peores para todo el que no esté en
> Florida. `/suggest` y `/forward` aceptan las dos; `/forward` las acepta **desde
> el 2026-09-11** y los APK que no las manden siguen funcionando.

#### `GET /api/geocode/suggest` — autocompletado

| Query | |
|---|---|
| `q` | **obligatorio**, mínimo 2 caracteres |
| `lat` · `lng` | opcional pero **recomendado** — el GPS del pasajero |
| `lang` | opcional, `en` por defecto. Formato `es` o `es-MX` |

```jsonc
// GET /api/geocode/suggest?q=calle%2084&lat=10.96854&lng=-74.78132&lang=es
[
  { "description": "Calle 84, Barranquilla, Atlántico, Colombia", "place_id": "ChIJ..." }
]
```

**Con `lat`/`lng` dentro de una zona** la búsqueda se restringe a esa zona
(`strictbounds`): lo que quede fuera del área **no aparece**. Es deliberado —
nadie escribe una dirección que no podemos servir— y es lo que evita que el
pasajero elija un destino que sólo va a fallar más tarde con el `422`.

**Sin `lat`/`lng`** el filtro duro no se puede aplicar —el sesgo cubre varias
ciudades y un solo círculo no alcanza— y entran resultados de fuera del área. Ahí
el `422` de §1.1 vuelve a ser la única defensa.

Devuelve `[]` ante cualquier fallo (sin clave de Google, error de la API, sin
resultados). Nunca lanza un 5xx, así que un array vacío no distingue «no hay» de
«falló».

#### `GET /api/geocode/place` — coordenadas de una sugerencia

```jsonc
// GET /api/geocode/place?place_id=ChIJ...
{ "lat": 25.7617, "lng": -80.1918, "address": "Brickell Ave, Miami, FL 33131, USA" }
```

**Usá siempre esto para resolver una sugerencia elegida.** Re-geocodificar el texto
de la descripción puede caer en otra ciudad —o en otro país— con el mismo nombre de
calle. Devuelve `null` si el `place_id` no resuelve.

#### `GET /api/geocode/reverse` — dirección de unas coordenadas

```jsonc
// GET /api/geocode/reverse?lat=10.96854&lng=-74.78132
{ "address": "Cl. 30 # 29-101, Sur Orient, Barranquilla, Atlántico, Colombia" }
```

Ante cualquier fallo devuelve `{ "address": "Current Location" }` — **nunca un
error**. Si la app muestra ese literal como si fuera una dirección real, se ve como
un bug; conviene detectarlo y sustituirlo por tu propia copia.

#### `GET /api/geocode/forward` — geocodificar texto libre

| Query | |
|---|---|
| `q` | **obligatorio** |
| `lat` · `lng` | opcional pero **recomendado** — decide en qué país se busca |

```jsonc
// GET /api/geocode/forward?q=Calle%2084%20%2345-20,%20Barranquilla&lat=10.96854&lng=-74.78132
{ "lat": 11.0008701, "lng": -74.8191054 }
```

Con GPS, la búsqueda se restringe al país de esa zona y el resultado es el portal
exacto. Sin GPS no se restringe país y se resuelve igual, aunque una dirección
ambigua puede caer en la ciudad equivocada del otro país. La caja del área es sólo
**una pista de encuadre, no un filtro**: validá siempre con el `422`.

Devuelve `null` si no encuentra nada.

#### `GET /api/geocode/directions` — ruta para dibujar en el mapa

| Query | |
|---|---|
| `originLat` · `originLng` · `destLat` · `destLng` | **obligatorio** |
| `waypoints` | opcional, formato de Google: `lat,lng|lat,lng` |

```jsonc
{
  "coordinates": [[-80.1918, 25.7617], /* ... */],   // ⚠️ [lng, lat], estilo GeoJSON
  "distanceMeters": 15749,
  "durationSeconds": 1392,
  "distanceText": "15.7 km",
  "durationText": "23 min",
  "steps": [
    {
      "distance": 240, "duration": 38,
      "instruction": "Head north on Brickell Ave",
      "maneuverType": "turn", "maneuverModifier": "left",
      "streetName": "", "coordinates": [[-80.19, 25.76]]
    }
  ]
}
```

Dos cosas: `coordinates` va en **`[lng, lat]`** (al revés de lo que espera
`LatLng` en la mayoría de SDK de mapas), y `streetName` viene siempre vacío —
el nombre de la calle está dentro de `instruction`. Devuelve `null` si no hay ruta.

Está cacheado del lado del servidor por coordenadas redondeadas a ~1 m, así que
pedir la misma ruta dos veces no consume cuota de Google.

### 1.4 Gestión de zonas — no es para el móvil

`GET/POST/PATCH/DELETE /api/admin/zones*` existen, pero son del panel y exigen rol
admin. La app no los toca. Se listan sólo para que nadie los busque.

---

## 2. Tarifa

El desglose campo por campo está en [`API_PRECIOS_MOBILE.md`](API_PRECIOS_MOBILE.md).
Aquí va lo que hace falta para **conectar**: qué endpoint usar en cada pantalla, y
los cargos que no salen de los endpoints de cotización.

### 2.1 Qué endpoint usar en cada momento

| Pantalla / momento | Endpoint | Por qué |
|---|---|---|
| El usuario arrastra el pin, cambia de clase, ajusta horas | `GET /api/rides/calculate-fare` | No llama a Google, responde en milisegundos, no consume cuota. Llamalo tantas veces como haga falta |
| Confirmación, con origen y destino ya fijados | `GET /api/rides/estimate` | Calcula la ruta real con Google **y valida la geocerca** |
| Crear el viaje | `POST /api/rides` | Recalcula y **sobrescribe** el `fare` que mandes |

Los dos de cotización piden token.

### 2.2 `GET /api/rides/calculate-fare`

**Por distancia** — `distanceKm`, `durationMinutes`, `vehicleType` (por defecto
`sedan`).
**Por hora** — `bookingType=hourly`, `hours` (> 0), `vehicleType`.

Respuestas completas en `API_PRECIOS_MOBILE.md` §1. Lo que importa al conectar:

- `total` es **lo que paga el pasajero**, con el 10% de plataforma ya incluido.
- `surge_multiplier` mayor que 1 hay que mostrarlo; si no, el usuario ve un precio
  alto sin explicación.
- Por hora, `billed_hours` puede ser mayor que `requested_hours`: el bloque mínimo
  se cobra completo. Mostralo explícito o parecerá un error de cálculo.
- `vehicleType` desconocido → `400 { "error": "Unknown vehicleType: …" }`.
- `hours` ausente o ≤ 0 con `bookingType=hourly` → `400`.

### 2.3 `GET /api/rides/estimate`

| Query | |
|---|---|
| `pickupLat` · `pickupLng` · `dropoffLat` · `dropoffLng` | **obligatorio** |
| `vehicleType` | por defecto `standard` (alias de `sedan`) |
| `stops` | opcional, JSON: `[{"lat":25.7,"lng":-80.2}]` |

Códigos que puede devolver:

| Código | Cuándo |
|---|---|
| `400` | Falta o no es numérica alguna coordenada, o `stops` no es un JSON válido |
| `422 outside_service_area` | Geocerca — §1.1 |
| `422 "No route found between those locations."` | Google no encuentra ruta entre los puntos |
| `500` | Falló la llamada a Google |

La respuesta trae los campos `snake_case` más dos duplicados heredados
(`distanceMiles`, `durationMinutes`): **usá los `snake_case`**.

Sigue devolviendo **una sola clase de vehículo por llamada**. Para mostrar las tres
a la vez: tres llamadas a `calculate-fare`, que no consumen cuota de Google.

### 2.4 Clases y alias

| Canónica | Alias aceptados |
|---|---|
| `sedan` | `business class` · `executive` · `standard` |
| `suv` | `premium suv` · `premier` · `luxury` |
| `van` | `van & sprinter` · `sprinter` · `max` |

Los importes salen de `app_config.fares_config` y un admin los cambia desde el
panel; los endpoints devuelven los nuevos al instante. **No los codifiques en el
APK.**

`concierge` y `valet` aparecen en el panel pero **no son clases de vehículo**: no
participan del cálculo por distancia y `calculate-fare` los rechaza con `400`.

### 2.5 Recargo por demanda

```jsonc
// GET /api/config/surge  (público)
{ "surge_multiplier": 1.35, "surge_reason": "Lluvia fuerte en el centro" }
```

Lo decide el servidor tomando **el mayor** entre el que un admin fijó a mano y el de
franja horaria, calculado con la **hora de la ciudad de operación**
(`America/New_York`), no con el reloj del teléfono. Las franjas están en
`server/config/pricing.ts:65`.

En la app: mostralo si es > 1, junto a `surge_reason` cuando venga. No lo calcules
—`getDynamicMultiplier()` y su tabla se pueden borrar—. Si mandás `surgeMultiplier`
en `POST /api/rides`, el servidor toma el **menor** entre el tuyo y el suyo: nunca
se cobra por encima de lo que mostraste en pantalla.

### 2.6 `GET /api/config` — lo que la app debería leer al arrancar

```jsonc
{
  "maintenance_mode": false,
  "min_version": "1.0.0",
  "surge_multiplier": 1,
  "multiplier": 1,              // duplicado heredado
  "surgeReason": null,
  "stripePublishableKey": "pk_live_...",
  "googleMapsApiKey": "AIza...",
  "googleMapsMapId": "795de..."
}
```

Si la base falla devuelve los valores por defecto con `200` — **nunca un error**,
para no dejar la app sin arrancar.

> **`min_version` está en `1.0.0`**, no en `1.2.0`. Si la app cuenta con esa red de
> seguridad para forzar actualización, hay que subirla desde el panel.

### 2.7 Cargos que NO salen de la cotización

Estos se aplican durante el viaje y no aparecen en el precio que ve el pasajero al
reservar. Los valores son los vigentes en `server/config/pricing.ts`:

| Cargo | Monto | Regla |
|---|---|---|
| Espera | $0.50 / min | Tras 5 minutos gratis desde `driver_arrived`. Topado en 60 min. Se suma al `fare` al completar |
| Recogida larga | $5.00 | Si el conductor está a ≥ 15 min. Lo dispara la app del conductor (§3.8) |
| No-show | $10.00 | Lo marca el conductor tras esperar los 5 minutos (§3.9) |
| Cancelación tardía | $10.00 | Pasados 2 minutos desde que el conductor aceptó. Por clase, `cancellationFee` |
| Cancelación de reserva programada | 100% si faltan < 2 h · 50% si < 24 h · 0% si más | Sobre el `fare` |
| Bono por viajes consecutivos | $3 a los 5 · $7 a los 10 · $15 a los 20 | Para el conductor |

> ❌ **Estos valores todavía no están en `/api/config`.** Si la app los muestra
> («los primeros 5 minutos son gratis», «cancelar ahora cuesta $10»), por ahora hay
> que mantenerlos como constantes de respaldo. Pedimos `wait_free_minutes`,
> `wait_fee_per_min` y `valet_fee` en `/api/config`: sigue pendiente de nuestro lado.

---

## 3. Conducción

El ciclo completo del conductor, en el orden en que ocurre. Los estados del viaje
son los de `server/services/stateMachine.ts`:

```
scheduled ──(cron, T-30min)──▶ searching ──(acepta)──▶ confirmed
                                                          │
                                              ┌───────────┴──────────┐
                                              ▼                      │
                                        driver_arrived               │
                                              │                      │
                                              └────────┬─────────────┘
                                                       ▼
                                                  in_progress ──▶ completed
```

`cancelled` se puede alcanzar desde cualquier estado activo, con una excepción: el
**pasajero no puede cancelar un viaje `in_progress`**; el conductor y el admin sí.

| A este estado | Desde | Quién puede |
|---|---|---|
| `confirmed` | `searching` | `driver`, `chauffeur`, `admin` |
| `driver_arrived` | `confirmed` | `driver`, `chauffeur`, `admin` |
| `in_progress` | `confirmed`, `driver_arrived` | `driver`, `chauffeur`, `admin` |
| `completed` | `in_progress` | `driver`, `chauffeur`, `passenger`, `admin` |
| `cancelled` | cualquiera activo | todos, con la excepción de arriba |

Una transición inválida devuelve `409` con un `error` en texto claro, pensado para
mostrarse tal cual. Un viaje ya `completed` o `cancelled` **no admite ningún
cambio**.

### 3.1 Conectarse

```http
PATCH /api/drivers/status
{ "is_online": true }
```

```jsonc
{ "success": true }
```

Desconectarse (`false`) **siempre se permite**. Conectarse puede fallar:

```jsonc
// 403
{ "error": "Debes registrar tu vehículo antes de conectarte.", "errorCode": "NO_VEHICLE" }
{ "error": "Tu cuenta aún no está aprobada.",                  "errorCode": "NOT_APPROVED" }
```

Son los dos únicos `errorCode`. El `error` ya viene en español y se puede mostrar
tal cual. Ante uno de ellos, la app debería llevar al conductor a la pantalla de
vehículo o a la de documentos según el código.

Para saber **por qué** no está aprobado, sin intentar conectarse:

```jsonc
// GET /api/drivers/verification-status
{
  "isBlocked": false,
  "blockReason": null,
  "selfieDue": false,
  "priorityScore": 1.0,
  "tripsCompleted": 42,
  "tripsRejected": 3
}
```

Además hay que entrar al pool de reparto por socket, o **no llegan solicitudes**:

```ts
socket.emit('driver:join_availability', { vehicleCategory: 'suv' })
// al desconectarse:
socket.emit('driver:leave_availability')
```

Un conductor con vehículo más grande recibe también solicitudes de clases más
pequeñas (SUV ve sedán; van y first class ven todo). Al revés no: un sedán nunca
recibe una solicitud de SUV.

> **Dos interruptores, no uno.** `PATCH /status` marca el estado en la base;
> `driver:join_availability` mete el socket en las salas de reparto. La app tiene
> que hacer los dos al conectarse, y en las reconexiones automáticas de Socket.IO
> (app en segundo plano) volver a emitir `driver:join_availability` — el servidor
> aprovecha ese evento para re-marcar `is_online`, que un `disconnect` pone en
> `false`.

### 3.2 Enviar ubicación

Dos caminos, **y hacen falta los dos**:

```http
POST /api/drivers/location          ← persiste (30 / 10 s)
{ "lat": 25.7617, "lng": -80.1918, "heading": 180, "speed": 12.5 }
```

```ts
socket.emit('driver:location', {    ← tiempo real, sin persistir
  rideId, lat, lng, heading, speed,
  rideStatus: 'in_progress',        // habilita detección de paradas y desvíos
})
```

El HTTP es lo que ve el despacho y el seguimiento del pasajero cuando no hay
socket; el socket es lo que mueve el coche en el mapa sin esperas. El socket
también persiste de forma asíncrona, pero **no sustituye al HTTP**: sin `userId` en
el handshake se descarta en silencio.

`heading` y `speed` aceptan `null`. Mandá `null` —no `0`— cuando el GPS no los
pueda calcular (parado, por ejemplo): el servidor conserva el último valor
conocido y la flecha del mapa del pasajero no salta al norte.

Rangos: `lat` −90..90, `lng` −180..180, `heading` 0..360, `speed` ≥ 0. Fuera de
rango → `400`. Rol que no sea `driver` ni `chauffeur` → `403`.

Una posición cada 3–5 s va sobrada. **Si dejás de mandar ubicación, un watchdog
marca al conductor fuera de línea** y emite `driver:went_offline` con
`reason: 'gps_inactivity'`.

### 3.3 Recibir solicitudes

**Por socket** — es el camino principal:

```jsonc
// evento: 'ride:new_request'
{
  "rideId": "uuid",
  "vehicleType": "Business Class",
  "pickupAddress": "1200 Brickell Ave, Miami",
  "ts": 1757520000000
}
```

El reparto es por olas: primero los conductores más cercanos y con mejor
`priority_score`, y escala en ~15 s hasta un broadcast general. Que llegue el
evento no garantiza exclusividad — **el primero que acepta se lo lleva** (§3.4).

El payload trae lo mínimo. Para pintar la tarjeta de la solicitud (pasajero,
precio, destino) hay que traer el viaje con `GET /api/rides/:id`.

> El payload **no incluye `driver_payout` ni `commission_amount`** todavía. Hasta
> que los agreguemos, la app tiene que seguir calculando el 90% por su cuenta. Está
> anotado como pendiente nuestro.

**Por HTTP** — para refrescar la lista al abrir la pantalla o al volver de segundo
plano:

```http
GET /api/rides/available
GET /api/rides/available?destMode=1&homeLat=25.76&homeLng=-80.19
```

Devuelve hasta 20 viajes en `searching` sin conductor, ya enriquecidos con
`passenger_name`, `passenger_phone`, `passenger_rating`, `passenger_avatar` y
`passenger_preferences`. Filtros que aplica el servidor:

- **Inmediatos:** sólo los creados en los últimos 20 minutos.
- **Programados:** sólo dentro de los 90 minutos previos a la hora de recogida
  (con 30 minutos de gracia para los que ya pasaron). Un viaje para mañana no
  aparece hoy.
- **Clase de vehículo:** según la del conductor, con la regla de vehículo mayor.
- Los viajes de valet se muestran a **todos** los conductores.

`destMode=1` sin `homeLat`/`homeLng` válidos → `400`. Con ellos, sólo deja los
viajes cuyo destino cae a menos de 5 km de ese punto.

> ⚠️ **El despacho no filtra por zona.** Se reparte por distancia y por
> `priority_score`, así que con dos ciudades abiertas la separación depende de que
> nadie esté a menos de 10 km de la otra —hoy es el caso, Miami y Barranquilla
> están a 1.700 km—. No es una garantía del sistema, es geografía.

> ⚠️ **Este endpoint acepta sólo los roles `chauffeur` y `admin`.** Un token con rol
> `driver` recibe `403 "Only drivers can view available rides"` aunque sí pueda
> aceptar viajes por `PATCH /:id/status`. Es una inconsistencia nuestra, no de la
> app; si los conductores tienen rol `driver`, decinos y lo unificamos.

### 3.4 Aceptar o rechazar

```http
PATCH /api/rides/:id/status
{ "status": "confirmed" }
```

```jsonc
{ "id": "uuid", "ride_status": "confirmed", "driver_id": "uuid" /* ... */ }
```

El servidor asigna `driver_id` solo, sella `accepted_at` (de donde salen los 2
minutos de gracia de cancelación) y cuenta la aceptación en las estadísticas.

| Código | Significado | Qué hacer en la app |
|---|---|---|
| `409` + `code: "DRIVER_BUSY"` | Ya tenés un viaje activo | Llevar al viaje en curso, no reintentar |
| `409` sin `code` | El viaje cambió de estado — trae `currentStatus` con el real | Sacar la tarjeta de la lista: alguien más lo tomó o el pasajero canceló |
| `404` | El viaje no existe | Sacarlo de la lista |

El `409` de carrera es **la respuesta normal** cuando dos conductores aceptan a la
vez: la escritura es atómica y sólo una gana. No es un error que haya que reportar.

Rechazar:

```http
POST /api/drivers/reject-ride
{ "rideId": "uuid" }
```

```jsonc
{ "newScore": 0.85, "isBlocked": false, "blockReason": null }
```

Baja el `priority_score`, lo que reduce las solicitudes futuras. Rechazos
consecutivos pueden bloquear la cuenta (`isBlocked: true` con motivo). Vale la pena
que la app lo diga antes de rechazar.

### 3.5 Reanudar después de cerrar la app

```http
GET /api/rides/driver-active
```

Devuelve el viaje activo del conductor, si hay. Es lo que permite volver a la
pantalla correcta después de que el sistema mate la app. Llamalo al arrancar, antes
de pintar la lista de solicitudes.

Y al entrar a un viaje, siempre:

```ts
socket.emit('join:ride', rideId)
// el servidor responde 'joined:ride' y, acto seguido,
// 'ride:status_changed' con el estado ACTUAL — no hace falta hacer polling
```

Ese estado de cortesía al entrar a la sala es la red contra la carrera clásica: el
pasajero se perdía el cambio de estado si el socket aún estaba conectándose.

### 3.6 Llegar a la recogida

```http
PATCH /api/rides/:id/status
{ "status": "driver_arrived" }
```

Arranca el contador de espera (`wait_started_at`), que decide el cargo por espera y
habilita el no-show.

> ⚠️ **El literal es `driver_arrived`.** Mandar `arrived` devuelve
> `409 "Invalid status: arrived"` — la máquina de estados no lo conoce, aunque
> aparezca en algún sitio del código.

Y por socket, para que el pasajero lo vea al instante:

```ts
socket.emit('driver:arrived', { rideId })
// el pasajero recibe 'ride:driver_arrived'
```

Comprobación opcional de proximidad, antes de marcar la llegada:

```http
POST /api/rides/driver-checkin/:id
{ "driverLat": 25.7617, "driverLng": -80.1918 }
```

| Código | |
|---|---|
| `200 { "success": true, "checkedIn": true }` | A menos de 500 m de la recogida |
| `400` + `code: "NOT_NEAR_PICKUP"` | Demasiado lejos |
| `400` + `code: "TOO_EARLY"` | Falta más de 30 min para un viaje programado |
| `403` | No sos el conductor asignado |
| `409` | El viaje no está en `confirmed` ni `driver_arrived` |

### 3.7 Empezar el viaje — el PIN es obligatorio

El PIN lo genera el servidor al reservar y lo ve el pasajero hasta que arranca el
viaje. **Ningún viaje pasa a `in_progress` sin verificarlo.**

```http
POST /api/rides/:id/verify-pin
{ "pin": "4821" }
```

```jsonc
{ "success": true, "message": "PIN verified. Ride activated.", "valetCommission": { "paid": false } }
```

La verificación correcta **ya pone el viaje en `in_progress`** y sella `started_at`.
No hay que llamar después a `PATCH /:id/status`.

| Código | |
|---|---|
| `401` + `code: "WRONG_PIN"` | PIN incorrecto |
| `429` + `code: "PIN_LOCKED"` | 5 intentos fallidos → bloqueado 15 min. Trae `retryAfterSeconds` y cabecera `Retry-After` |
| `400 "This ride does not require a PIN"` | Ya fue verificado (el PIN se borra al usarse) |
| `400 "Ride is no longer available"` | El viaje no está en `searching`, `confirmed` ni `driver_arrived` |

Existe también `POST /api/rides/ride/start` con `{ rideId, pin }`, equivalente pero
**sin protección contra fuerza bruta** y limitado al rol `chauffeur`. Usá
`verify-pin`.

Si por algún camino se intenta `PATCH /:id/status` a `in_progress` con el PIN sin
verificar:

```jsonc
// 409
{ "error": "PIN verification required to start this trip.", "code": "PIN_REQUIRED" }
```

### 3.8 Durante el viaje

Mandá `rideStatus: 'in_progress'` en `driver:location`: es lo que activa la
detección de paradas y de desvío de ruta, que emite `ride:stop_detected` y
`ride:route_deviation` a la sala del viaje.

Para que la detección de desvío funcione hay que registrar la ruta prevista una vez:

```ts
socket.emit('ride:set_route', { rideId, waypoints: [{ lat, lng }, /* ... */] })
```

Compensación por recogida larga:

```http
POST /api/rides/:id/long-pickup-fee
{ "etaMinutes": 18 }
```

```jsonc
{ "success": true, "longPickupFee": 5, "newFare": 71.5 }   // se aplicó
{ "applies": false, "etaMinutes": 12 }                      // menos de 15 min
{ "alreadyApplied": true, "longPickupFee": 5 }              // ya estaba aplicada
```

Sólo el conductor asignado (`403` en otro caso). Al pasajero le llega una
notificación push explicando el cargo.

### 3.9 Cerrar el viaje

**Completar:**

```http
PATCH /api/rides/:id/status
{ "status": "completed" }
```

Lo que dispara: sella `completed_at`, calcula el cargo por espera y lo suma al
`fare`, **captura el pago en Stripe** y transfiere el 90% al conductor (si tiene
Stripe Connect activo), actualiza racha y contadores, y manda el recibo por correo.
Todo eso ocurre en el servidor; la app sólo tiene que hacer esta llamada.

Después, para el bono por viajes consecutivos:

```jsonc
// POST /api/drivers/complete-bonus
{ "newScore": 1.15, "selfieDue": false }
```

**No-show** — el pasajero no apareció:

```http
POST /api/rides/:id/no-show
```

| Código | |
|---|---|
| `200` | Se cobran $10 y el viaje queda `cancelled` con `no_show: true` |
| `409` | Hay que esperar los 5 minutos primero — trae `waitedMinutes` |
| `409` | El viaje no está en `driver_arrived` ni `confirmed` |
| `403` | No sos el conductor asignado, o no sos conductor |

**Cancelar:**

```http
POST /api/rides/cancel/:id
{ "reason": "vehicle_issue", "cancelledBy": "driver" }
```

Con `cancelledBy: "driver"` desde `confirmed` o `driver_arrived`, el viaje **no se
cancela**: vuelve a `searching`, se libera el `driver_id` y se reparte a otros
conductores. Al pasajero no se le cobra nada.

```jsonc
{ "success": true, "reassigning": true, "cancellationFee": 0 }
```

Cancelar tarde tiene consecuencias para el conductor:

```jsonc
// POST /api/drivers/apply-sanction
{ "applied": true, "newRating": 4.85 }   // −0.15, con piso en 3.0
```

`in_progress` **no se puede cancelar por este endpoint**: `400 "Cannot cancel a
ride that is already in progress"`. Para cortar un viaje en curso hay que usar
`PATCH /:id/status` con `cancelled`, que sí lo permite para conductor y admin.

### 3.10 Roles: la trampa a tener presente

El sistema distingue `driver` de `chauffeur`, y los endpoints no coinciden:

| Endpoint | Acepta |
|---|---|
| `GET /api/rides/available` | `chauffeur`, `admin` — **no `driver`** |
| `POST /api/rides/ride/start` | `chauffeur`, `admin` — **no `driver`** |
| `POST /api/drivers/location` · `PATCH /api/drivers/status` | `driver`, `chauffeur` |
| `PATCH /api/rides/:id/status` · `reject-ride` · `complete-bonus` · `no-show` · `long-pickup-fee` | `driver`, `chauffeur` |

Es inconsistencia nuestra. Confirmanos qué rol llevan los tokens de conductor en
producción y lo unificamos de nuestro lado.

### 3.11 Lado pasajero: seguir al conductor

```jsonc
// GET /api/drivers/location/:driverId
{ "lat": 25.7617, "lng": -80.1918, "heading": 180, "speed": 12.5, "updated_at": "..." }
// 404 si el conductor nunca mandó posición
```

```jsonc
// GET /api/drivers/eta/:driverId?toLat=25.76&toLng=-80.19
{ "etaMinutes": 8, "distanceKm": 3.4, "driverLat": 25.77, "driverLng": -80.2,
  "source": "google_directions" }          // o "estimate" (30 km/h urbano)

{ "etaMinutes": null, "stale": true, "driverLat": null, "driverLng": null,
  "staleAgeMinutes": 12 }                  // posición de más de 5 minutos
```

Con `stale: true` **no muestres un coche en el mapa**: la posición es vieja y el
servidor la descarta a propósito.

```jsonc
// GET /api/drivers/available-counts   (público, sin token)
{ "executive": 4, "suv": 2, "concierge": 0 }
```

Para la pantalla de selección de clase. Ante cualquier fallo devuelve ceros con
`200`, así que «0 disponibles» no distingue «no hay» de «falló la consulta».
Tampoco distingue por ciudad: **cuenta los conductores en línea de todas las
zonas**.

Y en tiempo real, para el mapa de reserva:

```ts
socket.emit('passenger:watch_nearby')   // entra a la sala de posiciones
// llegan 'driver:nearby_update' y 'driver:went_offline'
socket.emit('passenger:leave_nearby')   // salí al dejar la pantalla
```

Es un **broadcast global**: llegan las posiciones de todos los conductores en línea,
no sólo los cercanos ni sólo los de la misma ciudad. Filtrá por distancia en el
cliente y salí de la sala al cambiar de pantalla.

---

## 4. Eventos de Socket.IO, en una tabla

### La app emite

| Evento | Payload | Quién |
|---|---|---|
| `join:ride` | `rideId` | ambos |
| `leave:ride` | `rideId` | ambos |
| `driver:location` | `{ rideId?, lat, lng, heading, speed, rideStatus? }` | conductor |
| `driver:join_availability` | `{ vehicleCategory? }` | conductor |
| `driver:leave_availability` | — | conductor |
| `driver:arrived` | `{ rideId }` | conductor |
| `ride:set_route` | `{ rideId, waypoints: [{lat,lng}] }` | ambos |
| `passenger:watch_nearby` | — | pasajero |
| `passenger:leave_nearby` | — | pasajero |

### El servidor emite

| Evento | Payload | Cuándo |
|---|---|---|
| `joined:ride` | `{ rideId }` | Confirmación de entrada a la sala |
| `ride:status_changed` | `{ rideId, status, driverId?, passengerId?, ... }` | Cambio de estado, y al entrar a la sala |
| `ride:status_update` | igual que el anterior | **Duplicado por compatibilidad** con APK viejos. Escuchá uno solo o vas a procesar cada cambio dos veces |
| `ride:new_request` | `{ rideId, vehicleType, pickupAddress, ts }` | Solicitud repartida a este conductor |
| `location:driver_update` | `{ driverId, lat, lng, heading, speed, ts }` | Posición del conductor, a la sala del viaje |
| `driver:nearby_update` | `{ driverId, lat, lng, heading, speed, ts }` | Posición, al broadcast de cercanía |
| `driver:went_offline` | `{ driverId, reason? }` | Desconexión. `reason: 'gps_inactivity'` si fue el watchdog |
| `ride:driver_arrived` | `{ rideId, driverId, ts }` | El conductor marcó llegada |
| `ride:stop_detected` | `{ rideId, ... }` | Parada no prevista durante `in_progress` |
| `ride:route_deviation` | `{ rideId, ... }` | Desvío de la ruta registrada |
| `passenger:message` | `{ rideId, message, fromPassenger, sentAt }` | Mensaje del pasajero al conductor |
| `chat:new_message` | `{ rideId, ... }` | Chat del viaje (sala aparte, sólo participantes) |

**Salas:** `user:<uid>` y `driver:<uid>` (automáticas), `ride:<rideId>` (con
`join:ride`; la conoce cualquiera con el UUID — es lo que permite el link público
de seguimiento), `ride-chat:<rideId>` (sólo pasajero, conductor y admin, entrada
automática al unirse a la sala del viaje).

---

## 5. Reconexión y estados raros

| Situación | Qué hace el servidor | Qué debería hacer la app |
|---|---|---|
| El socket se cae 10 s (app en segundo plano) | Marca `is_online: false` y arranca un plazo de gracia de 5 min | Al reconectar, reemitir `driver:join_availability`: el servidor re-marca `is_online` |
| El conductor no reconecta en 5 min con un viaje activo | Reasigna el viaje a otro conductor | Mostrar que el viaje se perdió; `GET /api/rides/driver-active` devuelve vacío |
| Se corta el GPS pero el socket sigue | El watchdog lo marca fuera de línea y avisa a los pasajeros | Detectar que no hay fix y avisar al conductor antes de que lo desconecten |
| La app vuelve del segundo plano | Nada automático | `GET /api/rides/driver-active`, `join:ride`, reemitir disponibilidad |
| Dos conductores aceptan el mismo viaje | Uno gana; el otro recibe `409` con `currentStatus` | Sacar la tarjeta, sin mensaje de error |
| `maintenance_mode: true` en `/api/config` | Los endpoints siguen respondiendo | Bloquear la app con tu propia pantalla: **el servidor no la impone** |

---

## 6. Pendientes de nuestro lado

Lo que bloquea trabajo en la app, en orden de impacto:

| Pendiente | Bloquea |
|---|---|
| `field: "pickup" \| "dropoff"` en el `422` de geocerca | Decir cuál de los dos extremos está fuera sin parsear el texto en inglés |
| Que origen y destino deban caer en la **misma** zona | Hoy un viaje Miami→Barranquilla pasa el control de geocerca (§1.2) |
| Moneda por zona (`currency` en `service_zones`) + huso de la zona para el surge | Cobrar en Barranquilla en su moneda y con su reloj, en vez de USD con la hora de Miami |
| `driver_payout` y `commission_amount` en `GET /api/rides/:id` y en `ride:new_request` | Borrar las 3 constantes de comisión del APK |
| `wait_free_minutes`, `wait_fee_per_min`, `valet_fee` en `/api/config` | Borrar del APK los valores de espera y valet |
| `options[]` en `/estimate` | Mostrar las tres clases con una sola llamada |
| Unificar `driver` y `chauffeur` en los endpoints de §3.10 | Que el rol del token no cambie qué endpoints funcionan |
| Despacho y `available-counts` filtrados por zona | Que un conductor y un pasajero de ciudades distintas no compartan cola ni contador |
| `min_version` real (hoy `1.0.0`) | La red de seguridad de actualización forzada |

## Preguntas para la app

1. **¿Qué rol llevan los tokens de conductor en producción, `driver` o `chauffeur`?**
   Decide qué endpoints funcionan hoy (§3.10).
2. ¿Queda en el APK alguna copia de la geocerca —centro, radio, `isInServiceArea`—?
   Se puede borrar entera.
3. ¿La app localiza los mensajes de error o muestra el `message` del servidor? De
   eso depende si vale la pena que traduzcamos las respuestas.
4. ¿Manda ya `lat`/`lng` en `/suggest`? Es lo que decide si el pasajero de
   Barranquilla encuentra su calle (§1.3).

---

## Anexo — cambios del 2026-09-11

El país con que se buscaban direcciones estaba fijo en `country:us` dentro de
`geocode.ts`. Con Barranquilla activa, eso dejaba a sus pasajeros sin poder
encontrar una dirección: el autocompletado devolvía vacío o calles de Florida, y
`/forward` resolvía una dirección de Barranquilla en **Colorado**, con un `200` y
sin ningún error.

Qué cambió, y qué significa para la app:

| Cambio | Efecto |
|---|---|
| El país sale de las zonas activas, no de una constante | Abrir un país nuevo desde el panel ya no necesita un despliegue del servidor ni de la app |
| `/suggest` busca en todos los países con zona activa | Un pasajero en Barranquilla encuentra su calle |
| `/suggest` vuelve a filtrar duro, ahora por la zona del pasajero | Con `lat`/`lng`, deja de ofrecer direcciones que no podemos servir. **Antes, con dos zonas abiertas, el filtro estaba apagado para todos** |
| `/forward` acepta `lat`/`lng` y restringe a un solo país | La dirección resuelve al portal exacto. Sin GPS no restringe país, que es mejor que restringir al equivocado |
| `/reverse` y `/place` | Sin cambios: ya funcionaban en los dos países |

Nada de esto rompe los APK actuales: los parámetros nuevos son opcionales y las
respuestas conservan su forma. Lo único que hay que hacer del lado de la app es
**empezar a mandar `lat`/`lng`** para aprovecharlo.

---

Código de referencia: geocerca en `server/services/serviceZones.ts`, tarifas en
`server/config/pricing.ts` y `server/services/fareConfig.ts`, estados en
`server/services/stateMachine.ts`, sockets en `server/services/socketService.ts`.
Los tests que fijan estas reglas están junto a cada archivo (`*.test.ts`).
