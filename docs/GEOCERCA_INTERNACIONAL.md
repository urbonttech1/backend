# Geocerca fuera de Estados Unidos

Extiende `ZONAS_DE_SERVICIO.md`. Ese documento explicaba cómo dejamos de necesitar
un despliegue para abrir una ciudad. Éste responde a otra pregunta: **qué falta
para abrir un país.**

---

## La conclusión primero

La geocerca ya funciona en cualquier continente. Lo que no funciona es **cobrar**.

Abrir Bogotá es una fila en `service_zones` — el motor la resolvería sin tocar una
línea de código. Pero esa fila haría que la plataforma cotizara **dólares por
milla** a un pasajero que espera pesos por kilómetro, y que intentara pagarle a un
conductor colombiano desde una cuenta de Stripe declarada en Estados Unidos.

Por eso este plan dedica una sección corta a la geocerca y el resto a lo que la
rodea. Invertir ese orden sería el error.

---

## Qué ya está listo

Verificado contra el código, no supuesto:

| Pieza | Por qué ya sirve |
|---|---|
| `center_lat` · `center_lng` | Latitud y longitud no saben de países. La validación ya acepta el rango completo, −90..90 y −180..180. |
| `radius_km` | Ya está en kilómetros. Es la parte del sistema que **no** hay que convertir. |
| `haversineKm()` | Mide sobre la esfera. No tiene ninguna suposición de hemisferio ni de país. |
| `timezone` | Cadena IANA. `America/Bogota` entra igual que `America/New_York`. |
| El contrato con la app | `422 outside_service_area` no menciona país, moneda ni unidad. |

Una zona nueva en otro continente se resuelve hoy con el mismo prefiltro de caja y
la misma prueba exacta. No hace falta migración para eso.

---

## Lo que hay que arreglar dentro de la geocerca

Son dos cosas, y sólo una es urgente.

### 1 · La zona pasa a ser la unidad de localización

Hoy una zona responde a una sola pregunta: **¿puedo aceptar este viaje?**

Para operar fuera de Estados Unidos tiene que responder a cuatro más: ¿en qué
moneda cobro, en qué unidad mido, con qué tarifario, y bajo qué país de Stripe
pago al conductor. Ese es el cambio conceptual del plan — todo lo demás se deriva
de él.

En la práctica, dos columnas nuevas:

```sql
ALTER TABLE service_zones ADD COLUMN country_code  CHAR(2)     DEFAULT 'US';
ALTER TABLE service_zones ADD COLUMN currency      CHAR(3)     DEFAULT 'USD';
```

`country_code` en ISO 3166-1 alpha-2, que es lo que esperan tanto Google como
Stripe. Ambas con valor por defecto, así que la zona de Miami no cambia y el
despliegue es transparente.

La unidad de distancia **no** va aquí: se deriva del país. Estados Unidos mide en
millas; el resto del mundo, en kilómetros. Una columna aparte permitiría estados
imposibles, como una zona colombiana midiendo en millas.

### 2 · El antimeridiano — bug latente, prioridad baja

`withBbox()` calcula la caja envolvente sumando y restando grados sin envolver.
Una zona centrada cerca de ±180° produce `maxLng = 181`, y la comprobación de
rango descarta puntos que **sí** están dentro del círculo.

Es un falso negativo: un viaje rechazado sin motivo. La suite de tests declara
explícitamente que el prefiltro nunca puede producirlos, así que hoy hay una
promesa que el código no cumple en ese meridiano.

Sólo afecta a Fiyi, Kiribati y el extremo oriental de Rusia. No es urgente, pero
son unas diez líneas —partir la caja en dos cuando cruza— y cierra un agujero que
el propio código promete no tener. Se arregla cuando se toque el archivo por
cualquier otra razón.

Cerca de los polos la caja degrada bien: el coseno está acotado a 0,01, la caja se
vuelve inútil como filtro pero **no produce falsos negativos**. No hay nada que
arreglar ahí.

---

## Lo que bloquea de verdad, y no es la geocerca

### Las tarifas no saben de zonas

`server/config/pricing.ts` **no menciona la palabra «zona» ni una sola vez.** Hay
un único tarifario para toda la plataforma: sedan, suv y van, con sus precios, y
punto.

Abrir un segundo país significa que el tarifario adquiera dimensión de zona: en la
base, en el motor de cobro, y en la pantalla de tarifas del panel. **Es más trabajo
que todo lo que llevamos hecho de geocerca**, y es el primer bloqueante real.

### La moneda está fija en el código

`currency: 'USD'` aparece dos veces en `pricing.ts` (líneas 228 y 281), y es lo que
viaja en cada cotización. No hay ningún sitio donde un pasajero pueda recibir otra
cosa.

### Las cuentas de Stripe se crean como estadounidenses

`country: 'US'` está fijo en `server/api/integrations.ts`, líneas 425 y 784.

Stripe Connect ata cada cuenta conectada a un país, con requisitos de verificación
y reglas de pago distintos según cuál. Un conductor colombiano no es una fila más:
hay que confirmar contra la documentación de Stripe **qué permite la cuenta de
plataforma actual**, y si los pagos transfronterizos aplican.

Esto no se puede planificar sin esa confirmación. Es lo primero que hay que
averiguar, antes de escribir una línea.

### Las millas viajan en el contrato con la app

`perMile` e `includedMiles` en el motor, y `distanceMiles` en el payload de
`POST /api/rides` y en la respuesta de cotización.

**Éste es el único punto del plan que obliga a la app móvil a cambiar.** Todo lo
demás se le puede entregar sin que se entere. Aquí no: o se manda la distancia en
la unidad de la zona, o se manda siempre en una unidad canónica y la app convierte
al pintar. Hay que decidirlo con ellos, y va atado a subir `min_version`.

### El buscador de direcciones está restringido a Estados Unidos

`components=country:us` en `server/api/geocode.ts`, líneas 228 y 364. No es un
sesgo: es un filtro. Fuera de Estados Unidos no devuelve nada.

Se resuelve tomando el país de la zona activa más cercana, igual que ya se hace
con el centro y el radio en `getSearchBias()`.

---

## Orden de trabajo

El criterio es empezar por lo que no rompe nada y terminar por lo que obliga a
publicar una versión de la app.

**Fase 0 · Preparar la zona.** Las dos columnas nuevas, con valor por defecto.
Opcionalmente el antimeridiano. Nadie nota nada: ni la app, ni el panel, ni un
solo cobro cambia.

**Fase 1 · Averiguar qué permite Stripe.** No es código. Es confirmar con la
documentación y con la cuenta de plataforma si se puede tener conductores fuera de
Estados Unidos, y bajo qué figura. **Si la respuesta es que no, el resto del plan
no tiene sentido** y hay que replantear la expansión desde el negocio.

**Fase 2 · Tarifas por zona.** El bloque grande. Esquema, motor y panel. Mientras
haya una sola zona el comportamiento debe ser idéntico al de hoy, y eso es lo que
hay que probar.

**Fase 3 · Moneda.** Deriva de la zona y viaja en la cotización. La app ya recibe
`currency`, así que probablemente sólo tenga que pintarlo en vez de asumir `$`.

**Fase 4 · Unidad de distancia.** El único cambio que se negocia con la app.
Atado a `min_version`.

**Fase 5 · Geocodificación por país.** Pequeño, y sin él no se pueden buscar
direcciones en el país nuevo.

---

## Cómo se prueba que no rompimos nada

La prueba que ya define el éxito de la geocerca **debe seguir pasando idéntica**,
byte a byte:

```
Naples con radio 125 km            → 422 outside_service_area
ampliar el radio desde el panel    → Naples pasa a 200, sin reiniciar
restaurar                          → 422 de nuevo
```

Y se añaden tres:

1. **Una zona en otro país resuelve.** Un punto de Bogotá dentro de una zona de
   Bogotá entra; uno de Medellín, fuera del radio, no.
2. **Dos zonas en países distintos no se contaminan.** Un punto de Miami resuelve
   a la zona de Miami, con su moneda y su tarifario, no con los de Bogotá.
3. **El antimeridiano**, si se arregla: una zona centrada en 179,9° acepta un punto
   en −179,9°.

---

## Lo que este plan no hace

- **No toca `serviceZones.ts` ni `create.ts`** salvo para leer las columnas nuevas.
  El motor de resolución se queda como está, porque ya es correcto.
- **No mete polígonos.** Sigue bloqueado: PostGIS está instalado en el esquema
  `tiger` y sus tipos no se resuelven.
- **No resuelve impuestos.** Facturación, IVA y retenciones por país son un mundo
  aparte que no hemos mirado.
- **No resuelve el idioma.** Los mensajes de error de la API están en inglés.

---

## La decisión que hay detrás

Todo esto se justifica si la expansión internacional es real y próxima. Si el
horizonte fueran más ciudades de Estados Unidos, **nada de este documento haría
falta**: la geocerca ya sirve, el tarifario único es correcto, y Stripe y las
millas no estorban.

La Fase 1 —averiguar qué permite Stripe— cuesta una tarde y puede invalidar el
resto. Conviene hacerla antes de comprometerse con las demás.
