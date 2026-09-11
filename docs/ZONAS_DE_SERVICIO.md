# Zonas de servicio

> **Estado:** propuesta, sin implementar
> **Fecha:** 2026-09-10
> **Alcance:** `urbont-api` + `panelv2`

De un círculo fijo en el código a zonas gestionables desde el panel.

## Por qué

La geocerca es hoy un círculo de 125 km alrededor de Miami, con centro y radio
hardcodeados en `server/api/rides/create.ts:66-67`. Funciona, pero arrastra tres
problemas concretos:

1. **Excluye mercado propio.** Naples (166 km) y Key West (209 km) quedan fuera,
   siendo sur de Florida.
2. **Contradice lo que promete el sitio.** El formulario de conductores ofrece 14
   ciudades en 7 estados. Orlando está a 330 km, Atlanta a 976. Un chofer puede
   darse de alta para Orlando, subir sus 17 documentos y ser aprobado — y ningún
   pasajero de Orlando podrá reservarle un viaje.
3. **Hay dos centros de Miami distintos**, sin relación entre sí: el de la
   geocerca y el de `geocode.ts:196-197`, que sesga la búsqueda de direcciones.

**Lo que este plan NO hace, y por qué.** El análisis destapó que a partir de dos
zonas hacen falta permisos por zona, despacho filtrado por zona y tarifas por
zona — nada de eso existe hoy. Meterlo ahora sería construir para un problema que
todavía no se tiene. Lo que sí se hace es **dejar la firma correcta**, porque eso
es lo caro de cambiar después.

---

## Estado verificado

| Pieza | Situación |
|---|---|
| Geocerca | Círculo único, hardcodeado, evaluado en 4 puntos de `create.ts` |
| PostGIS | **Instalado** en Supabase, sin ninguna columna geométrica en uso |
| `profiles.operating_city` | Existe y se edita desde el panel — **no se usa en el flujo de viajes** |
| Despacho de choferes | Sólo por distancia (10 km), nunca por ciudad ni permisos |
| App móvil | **No tiene copia de la geocerca**: sólo reacciona al `422 outside_service_area` |
| `city_demands` | Tabla creada, vacía. El sitio ya tiene página de votación por ciudad |

### El rendimiento no es un problema y conviene decirlo

Medido: comprobar **100 zonas en memoria** cuesta 3,3 µs por consulta, o 0,27 µs
con prefiltro de caja envolvente. Una consulta a la base son 1–5 ms — entre mil y
quince mil veces más lenta.

**La verificación va en memoria.** La base guarda y el panel edita; el camino
caliente no la toca. Es el mismo reparto de responsabilidades que ya construimos
para las tarifas.

### Un bug aparte que conviene arreglar de paso

`find_nearby_drivers` **no existe en la base** (0 filas en `pg_proc`) y
`driver_locations` **no tiene la columna `location`** que esa función referencia.
La migración que la crea nunca se aplicó del todo.

Resultado: cada despacho falla el RPC, cae al `catch` de
`socketService.ts:754` y usa una consulta manual sin índice espacial, dejando un
`log.warn` por viaje. Es la misma familia que las columnas fantasma que ya
corregimos.

---

## Diseño

### La firma es el cambio importante

```ts
// hoy
isInServiceArea(lat, lng): boolean

// después
resolveZone(lat, lng): Zone | null
```

Un booleano no basta en cuanto haya dos zonas, y hay evidencia en el propio
catálogo de documentos: *Miami-Dade Airport Permit*, *Port of Miami Permit* y
*Miami-Dade Limousine Sticker* son permisos **de condado**. A un chofer de Orlando
no se le pueden pedir. Lo mismo con el huso horario que usa `getTimeSurge()`, hoy
fijo en `America/New_York`.

Devolver la zona deja preparado todo eso sin implementarlo aún.

### Modelo

```sql
CREATE TABLE service_zones (
  id           TEXT PRIMARY KEY,          -- 'miami'
  name         TEXT NOT NULL,             -- 'Miami / Sur de Florida'
  active       BOOLEAN NOT NULL DEFAULT true,
  timezone     TEXT NOT NULL DEFAULT 'America/New_York',
  -- Forma: círculo ahora, polígono cuando se dibuje
  center_lat   NUMERIC, center_lng NUMERIC, radius_km NUMERIC,
  boundary     GEOGRAPHY(POLYGON, 4326),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

Las dos formas conviven: si hay `boundary` manda el polígono, si no el círculo.
Eso permite **empezar hoy con círculos y migrar zona por zona** sin volver a tocar
el código de negocio.

`timezone` entra desde el principio aunque todavía no se use: es la columna que
después arregla el surge fuera de Florida.

### Resolución en memoria, dos pasos

`server/services/serviceZones.ts`, calcado de `services/fareConfig.ts`:

- Carga al arrancar, tras las migraciones
- `invalidateZones()` cuando el panel guarda
- TTL de respaldo para las instancias de ECS
- Si la base falla, cae a la zona de Miami por defecto — **nunca lanza**, porque
  dejaría la app sin poder reservar

El resolutor:

1. **Prefiltro por caja envolvente**, precalculada al cargar. Cuatro comparaciones
   descartan casi todas las zonas.
2. **Prueba exacta** sobre las supervivientes: distancia si es círculo,
   punto-en-polígono si es polígono.

### La zona se congela al crear el viaje

`rides.zone_id`, fijado junto a `locked_fare` y por la misma razón: el pasajero
aceptó un precio que pertenece a una zona. Si la zona se reevaluara durante el
trayecto, un viaje cambiaría de tarifa al cruzar una línea invisible.

Cruzar zonas **en medio de un viaje deja de importar** con esto. El problema real
—un chofer operando donde no tiene permisos— es entre viajes, y se aborda cuando
exista la segunda zona.

---

## Alcance

### Entra

1. Tabla `service_zones` + semilla con el círculo actual, valores idénticos.
2. `serviceZones.ts` con carga, caché e invalidación.
3. `resolveZone()` reemplaza a `isInServiceArea()` en los 4 puntos de `create.ts`.
   El 422 sigue devolviendo el mismo `outside_service_area`, así que **la app móvil
   no cambia**.
4. `rides.zone_id`, escrito al crear.
5. **Gestión desde el panel** — detallada abajo.
6. `geocode.ts` toma el centro de la zona en vez de su constante propia.
7. **Arreglar `find_nearby_drivers`**: crear la columna `location` en
   `driver_locations`, poblarla desde `lat`/`lng`, mantenerla con un trigger, e
   índice GiST.

### La pantalla del panel

Nueva entrada **Zonas** en `panelv2`, junto a Tarifas. Mismo patrón que
`(dashboard)/fares/page.tsx`, que ya sirve de molde probado.

**Qué puede hacer el operador:**

| Acción | Efecto |
|---|---|
| Ver las zonas y su estado | Lista con nombre, centro, radio y si está activa |
| Crear una zona | Nombre, centro, radio y huso horario. Orlando pasa a ser una fila, no un despliegue |
| Ajustar el radio | Decide si Key West y Naples entran. Se ve el efecto al momento |
| **Activar y desactivar** | Interruptor por zona. Cerrar una ciudad —por clima, por regulación, por falta de choferes— es un clic, no una intervención de urgencia |
| Ver la demanda | `city_demands` ya existe y el sitio ya vota por ciudad. Ahí se ve dónde piden servicio, para decidir qué abrir |

**Vista previa en mapa.** El panel ya tiene `VITE_GOOGLE_MAPS_API_KEY`
configurada. Un mapa con el círculo dibujado y las ciudades conocidas marcadas
—dentro en verde, fuera en gris— convierte «radio 125 km» en una decisión
informada. Sin eso, el operador está eligiendo un número a ciegas.

**Endpoints**, calcados de los de tarifas:

```
GET    /api/admin/zones          listar
POST   /api/admin/zones          crear
PATCH  /api/admin/zones/:id      editar centro, radio, nombre, huso
PATCH  /api/admin/zones/:id/active   activar o desactivar
```

**Tres cosas que aprendimos con las tarifas y hay que traer desde el principio:**

1. **Que guardar surta efecto de inmediato.** Cada escritura llama a
   `invalidateZones()`. Sin eso el cambio no aplica hasta el próximo arranque —
   fue exactamente el bug del editor de tarifas.
2. **Registro en `audit_logs`.** Quién cambió qué zona y con qué valores. Mover
   una geocerca decide quién puede pedir un viaje: tiene que dejar rastro.
3. **Que el `PATCH` diga qué ignoró.** Devolver `applied` y `rejected` como hace
   ahora el de tarifas, para que el panel no dé por guardado lo que se descartó.

**Una guarda propia de esta pantalla:** no permitir desactivar la última zona
activa, ni dejar un radio en 0. Ambas cosas dejarían la plataforma sin poder
aceptar un solo viaje, y desde una pantalla que no advierte de ello.

### No entra, y se documenta

- **Permisos por zona.** Los 17 documentos siguen siendo iguales para todos.
- **Despacho filtrado por zona.** Sigue siendo sólo por distancia.
- **Tarifas por zona.** Un solo tarifario, como hoy.
- **Viajes entre zonas.** Se siguen rechazando: origen y destino deben caer en la
  misma zona activa.
- **Dibujo de polígonos en el panel.** Sólo círculos en esta tanda — y por ahora
  no hay alternativa: PostGIS vive en el esquema `tiger` y el tipo `geography` no
  se resuelve. La columna `boundary` se quitó de la migración; `hasBoundary`
  queda en el modelo como el punto donde entrará, y hoy siempre es `false`.

### El sesgo de búsqueda de direcciones, que también estaba hardcodeado

`server/api/geocode.ts` tenía cinco constantes con las coordenadas de Miami que
orientan el autocompletado. Ahora salen de `getSearchBias()`, derivado de las
zonas activas: centro y radio de la zona más grande, caja como unión de todas.

Con ellas venía un detalle que no era el que decía el comentario: `strictbounds=true`
**no sesga, filtra**. Con una zona es lo que queremos. Con dos ciudades lejanas
habría excluido a la segunda, porque `location`+`radius` es un solo círculo — así
que ahora sólo se aplica cuando hay exactamente una zona activa.

Cada uno de estos se vuelve necesario cuando se active la segunda zona. Con el
modelo puesto, ninguno obliga a rehacer lo anterior.

---

## Verificación — ejecutada el 2026-09-10

Todo contra el servidor local con la base de producción, sin reiniciar entre pasos.

| # | Qué | Resultado |
|---|---|---|
| 1 | `npx tsc --noEmit && npx vitest run` | **0 errores · 62 tests en verde** |
| 2 | No-regresión: Fort Lauderdale (40 km) y West Palm Beach (107 km) dentro; Naples (166), Key West (209), Orlando (330), Tampa (331), Atlanta (976) fuera | ✅ en tests |
| 3 | El prefiltro de caja no produce falsos negativos: borde a 124 km en las cuatro direcciones | ✅ en tests |
| 4 | El cargador lee la base al arrancar | ✅ `[Zonas] 1 activa(s): miami` |
| 5 | **El circuito que define el éxito** | ver abajo |
| 6 | Guarda de la última zona activa | ✅ `409` + mensaje explícito |
| 7 | Auditoría | ✅ dos filas en `audit_logs`: `zones.update · miami → radiusKm=250` y `=125` |

### El circuito, paso a paso

```
1) Naples con radio 125 km            → 422 outside_service_area
2) PATCH /api/admin/zones/miami {radiusKm:250}  → 200, y el log registra
                                          [Zonas] 1 activa(s): miami
3) Naples, SIN reiniciar              → 200, tarifa calculada
4) PATCH .../active {active:false}    → 409 «Cannot deactivate the last
                                          active zone»
5) PATCH {radiusKm:125}               → 200
6) Naples de nuevo                    → 422 outside_service_area
7) Miami sigue funcionando            → 200, total $52.91
```

El paso 3 es el que importa: **abrir una ciudad dejó de ser un despliegue**.

Estado restaurado al terminar: `miami`, 125 km, activa. Las dos filas de
`audit_logs` se dejaron a propósito — son el registro fiel de dos cambios reales
hechos por un admin, y borrar auditoría es peor práctica que dejar ruido.

### Lo que esta verificación NO cubre

- **`find_nearby_drivers`** sigue sin arreglar: PostGIS está instalado en el
  esquema `tiger`, no en `public` ni `extensions`, así que sus tipos no se
  resuelven. Es lo mismo que bloquea los polígonos. El `log.warn` de
  `socketService.ts:754` sigue apareciendo.
- **`zone_id` en un viaje real**: el código lo congela al crear, y está cubierto
  por tipos y revisión, pero no se creó un viaje de verdad para no ensuciar la
  base de producción.
- **La pantalla del panel** no está construida; los endpoints se probaron con
  `curl`.

---

## Después de esto

Añadir Orlando o Tampa pasa a ser **una fila en una tabla desde el panel**, no un
despliegue. Ese es el objetivo de la tanda.

Y queda pendiente una decisión de negocio, no técnica: **hasta dónde llega el área
de Miami**. ¿Entra Key West? ¿Naples? Con el radio en la base es un número que se
ajusta en el panel y se ve el efecto al momento.
