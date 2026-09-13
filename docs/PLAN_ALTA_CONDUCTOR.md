# Plan de implementación — alta de conductor

> **Para:** backend (`urbont-api`) y app móvil (`UrbontApp/urbont`)
> **Parte de:** [`Manual-tecnico-URBONT.md`](Manual-tecnico-URBONT.md), capítulo 01
> **Fecha:** 2026-09-13
> **Verificado contra:** el código de `urbont-api` en `master` y la base de producción
>
> ## ✅ Fases 1 y 2 implementadas el 2026-09-13
>
> Todo el trabajo de servidor está hecho y probado; **nada requiere una versión
> nueva de la app**. Lo pendiente son las fases 3 (app) y 4 (negocio). El detalle
> de cada tarea sigue abajo tal como se planificó, con su estado.
>
> | Tarea | Estado |
> |---|---|
> | 1.1 Guardar `expiryDate` y encender el cron de vencimientos | ✅ |
> | 1.2 `selfieDue` calculado de verdad | ✅ |
> | 1.3 Ruta `/api/admin/cities` duplicada | ✅ |
> | 1.4 Documentar los códigos de error nuevos | ✅ |
> | 2.1 `GET /api/chauffeur/required-docs` | ✅ |
> | 2.2 `GET /api/config/cities` | ✅ |
> | 2.3 `GET /api/config/vehicle-categories` | ✅ |
> | 2.4 Publicar los límites de subida | ✅ (dentro de 2.1) |
> | 2.5 Unificar `/submit` y `/submit-documents` | ✅ |

Qué de lo que describe el manual **ya está**, qué **falta**, y en qué orden hacerlo
para que el conductor no note ninguna transición.

---

## La regla que ordena todo el plan: nada se rompe en el camino

Hay APKs en la calle que no se van a actualizar solos. El plan se ordena por eso, no
por dificultad:

1. **Primero lo que se arregla solo en el servidor.** Sin desplegar app, sin que nadie
   note nada salvo que algo empieza a funcionar.
2. **Después contratos nuevos, siempre aditivos.** Endpoints que se suman; los campos
   nuevos en respuestas existentes son opcionales. Un APK viejo los ignora y sigue
   igual.
3. **Al final lo que exige app nueva**, ya con el servidor listo y esperando.

**Ninguna tarea de este plan cambia el significado de un campo existente ni retira un
endpoint.** Donde hay que sustituir algo, el reemplazo convive con lo viejo hasta que
el APK viejo deje de usarse.

---

## Estado de los hallazgos del manual

| # | Hallazgo del manual | Servidor | App | Fase |
|---|---|---|---|---|
| 1 | Dos listas de 11 documentos que no coinciden | 🟡 Las listas ya están unificadas en el código; falta exponerlas | ❌ Cada pantalla trae la suya | 2 · 3 |
| 2 | Barranquilla no se puede elegir como ciudad | 🟡 Catálogo `cities` y `service_zones` ya existen; falta endpoint público | ❌ Lista fija de 20 ciudades de EE. UU. | 2 · 3 |
| 3 | Verificación de identidad sin conectar | ❌ `selfieDue` está fijo en `false` y no hay quien lo active | ❌ Pantalla sin renderizar, CSP bloquea el SDK | 1 · 3 |
| 4 | Token de sesión en los logs | — | ❌ | 3 |
| 5 | Categorías de vehículo distintas | ✅ El servidor ya normaliza ambas; no rompe hoy | 🟡 Dos vocabularios | 2 · 3 |
| 6 | Requisitos solo de EE. UU. | ❌ Una sola lista de documentos para todos los países | ❌ Textos fijos en inglés | 4 |
| 7 | Google se salta vehículo y documentos | ✅ El servidor bloquea con `NO_VEHICLE` | 🟡 Decisión de producto | 4 |
| 8 | Contraseña débil permitida | ✅ El servidor exige 8+, mayúscula y número | ❌ La app valida 2 de 4 | 3 |
| 9 | Documentos en base64 dentro de JSON | ✅ Límites puestos; falta publicarlos | 🟡 No los conoce | 2 |
| 10 | Código heredado | — | ❌ | 3 |

**Además, cinco cosas que aparecieron al contrastar el manual con el código.** Ninguna
está en el manual porque solo se ven desde el servidor.

| # | Hallazgo | Gravedad | Fase |
|---|---|---|---|
| 11 | `expiryDate` se descarta al subir un documento, y eso deja muerto el cron de vencimientos | **Alta** | 1 |
| 12 | Los códigos de error del alta cambiaron y el manual documenta los viejos | Media | 1 · 3 |
| 13 | `GET /api/admin/cities` está declarado dos veces; la segunda es inalcanzable | Media | 1 |
| 14 | `/submit` y `/submit-documents` hacen casi lo mismo | Baja | 2 |
| 15 | `GET /api/drivers/verification-status` devuelve más campos de los documentados | Baja | 3 |

---

## Fase 1 — Arreglos que no necesitan app nueva

Todo esto se despliega en el servidor y surte efecto en los APK que ya están
instalados. Es la fase con mejor relación resultado/riesgo.

### 1.1 · Guardar `expiryDate` — el más importante del plan

**Qué pasa hoy.** La app envía `expiryDate` en `POST /api/chauffeur/upload-doc`, y el
servidor **no lo lee**: [chauffeur-docs.ts:172](../server/api/chauffeur-docs.ts#L172)
solo desestructura `docKey`, `fileName`, `mimeType` y `base64`.

La consecuencia no es que se pierda un dato. Es que hay un sistema completo montado
encima de ese campo y **no ha funcionado nunca**:
`driver_documents.expiry_date` existe, el cron de
[cron.ts:788-860](../server/jobs/cron.ts#L788) lo consulta cada día, avisa al conductor
a 30 y a 7 días del vencimiento, y **suspende al conductor** cuando el documento
caduca. Como ninguna fila tiene fecha, el cron no encuentra nada: registra
`No expiring documents found` y termina.

Es decir: hoy circulan conductores con seguros o permisos vencidos y el sistema que
debía detectarlos está en marcha, mirando una columna vacía.

**Qué hacer.** Leer el campo, validarlo y persistirlo:

- Aceptar `expiryDate` en formato `YYYY-MM-DD`; si no lo es, ignorarlo sin fallar la
  subida (el documento importa más que la fecha).
- Rechazar fechas ya pasadas con un código propio, `DOCUMENT_EXPIRED`, para que la app
  pueda decir «ese documento ya venció» en vez de aceptarlo.
- Añadir `expiry_date` a `upsertDocRecord`, y resetear `notified_30d` y `notified_7d`
  a `false` en cada re-subida: un documento renovado tiene que volver a poder avisar.
- Aceptarlo también en el lote `POST /api/chauffeur/documents`, admitiendo que el valor
  venga como objeto `{ dataUrl, expiryDate }` además del string actual.

**Transparencia.** Total: la app ya envía el campo. Empieza a guardarse sin tocar el
APK. Lo único visible será que los avisos de vencimiento empiezan a llegar — que es lo
que se busca.

**Esfuerzo.** ~30 líneas y dos tests. **Riesgo:** bajo; si la fecha no llega, todo se
comporta como hoy.

> **Antes de encender el cron a fondo:** los documentos ya cargados no tienen fecha, así
> que nadie será suspendido de golpe. La suspensión solo puede dispararse para
> documentos subidos después de este cambio. Conviene confirmarlo con una consulta
> antes del despliegue.

### 1.2 · Que `selfieDue` signifique algo

**Qué pasa hoy.** `POST /api/drivers/selfie-verify` funciona: registra en
`driver_selfie_log` y actualiza `last_selfie_at`, `trips_since_selfie` y
`selfie_due_at`. Pero quien informa del estado,
[driverScore.ts:46](../server/services/driverScore.ts#L46), devuelve `selfieDue: false`
**fijo**, sin mirar ninguno de esos tres campos. La app, por su parte, no renderiza la
pantalla. Los dos extremos están desconectados a la vez.

**Qué hacer en el servidor.** Calcular `selfieDue` con lo que ya se guarda: `true` si
`selfie_due_at` ya pasó, o si `trips_since_selfie` supera el umbral, o si
`last_selfie_at` tiene más de una semana. Un solo `SELECT` más en una consulta que ya
se hace.

**Transparencia.** El campo ya viaja en la respuesta y la app hoy lo ignora. Cuando
empiece a llegar en `true` no cambia nada visible hasta que la app lo use (fase 3).

**Esfuerzo.** ~20 líneas. **Riesgo:** ninguno mientras la app no lo consuma.

### 1.3 · La ruta de ciudades del panel que nadie alcanza

`adminRouter.get("/cities")` está declarado **dos veces**: en
[admin.ts:1680](../server/api/admin.ts#L1680) como buscador del catálogo geonames, y en
[admin.ts:1873](../server/api/admin.ts#L1873) como lista de ciudades de servicio del
panel. Express usa la primera y la segunda es código muerto.

Efecto real: la pantalla Ciudades del panel pide `/api/admin/cities` sin `q`, y el
buscador responde `{ cities: [] }` porque exige dos caracteres. La pantalla se ve
vacía y su lista de expansión no aparece nunca.

**Qué hacer.** Renombrar el buscador a `GET /api/admin/cities/search` y dejar
`/cities` para la pantalla. Es cambio de panel, no de app móvil.

**Esfuerzo.** Dos líneas más el ajuste en `panelv2`. **Riesgo:** bajo, pero hay que
desplegar los dos a la vez.

### 1.4 · Cerrar el desfase de los códigos de error

Los códigos del alta cambiaron el 2026-09-12 y el manual documenta los anteriores. No
es un fallo del servidor: es que la referencia de la app quedó atrás.

Códigos nuevos que hoy no están documentados: `EMAIL_IN_USE_OTHER_ROLE`, `UNDERAGE`,
`INVALID_DOB`, `INVALID_PHONE`, `INVALID_YEAR`, `INVALID_CITY`, `PROFILE_SAVE_FAILED`,
`AUTH_SERVICE_UNAVAILABLE`, `REGISTRATION_FAILED`, `VEHICLE_SAVE_FAILED`,
`CITY_SAVE_FAILED`, `SUBMIT_FAILED`, `STATUS_UNAVAILABLE`, y el campo `action`.

**Qué hacer.** Actualizar las dos tablas del manual (§Formulario de registro y
§Contrato con el backend). Sin código de por medio.

---

## Fase 2 — Contratos nuevos, aditivos

Endpoints que se suman. La app los adopta cuando le convenga; hasta entonces mantiene
sus listas fijas como respaldo y nada se rompe.

### 2.1 · `GET /api/chauffeur/required-docs`

**Es el pedido explícito del manual**, y del lado del servidor casi todo está hecho: las
tres listas ya viven unificadas en
[driverVerification.ts](../server/services/driverVerification.ts) — `REQUIRED_DOC_KEYS`
(11, los del registro), `LEGACY_DOC_KEYS` (11, esquema de limusina) y `WEB_DOC_KEYS`
(17, el signup web), con `ACCEPTED_DOC_KEYS` como unión. El servidor ya acepta las tres.

Lo que falta es publicarlas, con la etiqueta y la ayuda de cada documento —hoy sólo
viven en el código de la app— y con si lleva fecha de vencimiento:

```jsonc
{
  "docs": [
    {
      "key": "license",
      "label": "Driver's License",
      "category": "Personal Identity",
      "hint": "Front & back, clearly visible",
      "required": true,
      "expires": true
    }
  ],
  "totalRequired": 11,
  "acceptedMimeTypes": ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  "maxFileBytes": 10485760,
  "maxBatchBytes": 52428800
}
```

Con esto el aviso «upload all 11 required documents» puede por fin decir cuáles, y las
dos pantallas de la app dejan de contradecirse porque leen la misma fuente.

**Transparencia.** Total: es un endpoint nuevo. La app lo consume en fase 3 y, si falla
la llamada, cae a su lista actual.

**Esfuerzo.** ~80 líneas, casi todas la tabla de etiquetas.

### 2.2 · `GET /api/config/cities` — ciudades operativas

**Qué pasa hoy.** La app trae 20 ciudades de EE. UU. escritas a mano, así que un
conductor de Barranquilla no puede darse de alta en su ciudad aunque el servidor ya
opere allí.

**Lo que ya existe y no se está usando:** la tabla `cities` en producción, catálogo
geonames con `country_code`, `admin1`, `lat`, `lng`, `population` y `timezone`.
Verificado: Barranquilla está, con `CO` y `America/Bogota`. Y `service_zones` sabe qué
zonas están activas y en qué país.

**Qué hacer.** Un endpoint público que cruce las dos cosas: las ciudades del catálogo
que caen dentro de una zona activa, más las de los países donde operamos.

```jsonc
{
  "cities": [
    { "id": "miami-us",       "name": "Miami",        "region": "FL", "country": "US", "zoneId": "miami" },
    { "id": "barranquilla-co","name": "Barranquilla", "region": "Atlántico", "country": "CO", "zoneId": "barranquilla" }
  ],
  "default": "miami-us"
}
```

**Transparencia.** Endpoint nuevo; la app mantiene su lista como respaldo. Abrir una
ciudad deja de necesitar una versión del APK, que es el mismo principio que ya rige la
geocerca y las tarifas.

**Esfuerzo.** ~60 líneas y una consulta.

### 2.3 · Categorías de vehículo desde el servidor

El registro ofrece `SUV` y `Sedan`; el editor usa `executive`, `suv`, `van` y
`signature`. **Hoy no rompe nada** porque
[`normalizeVehicleCategory`](../server/services/socketService.ts#L665) traduce ambos
vocabularios, y `VEHICLE_ALIAS` hace lo propio con las tarifas. Pero son tres listas
manteniéndose por acuerdo tácito, y ya hay una grieta: `signature` y `concierge` tienen
sala de reparto propia y **no tienen tarifa** en `DEFAULT_FARE_CLASSES`.

**Qué hacer.** Añadir las categorías a `GET /api/config`: clave canónica, etiqueta,
alias aceptados y si admite reserva. Y decidir qué pasa con `signature` y `concierge`
(fase 4).

**Esfuerzo.** ~30 líneas.

### 2.4 · Publicar los límites de subida

El manual pregunta por el tamaño máximo del body. La respuesta ya está en el código:
**50 MB** para el lote de `POST /api/chauffeur/documents`, **15 MB** para
`upload-doc`, y **10 MB por archivo**
([server.ts:509-510](../server.ts#L509-L510)). Van dentro de `required-docs` (§2.1) para
que la app pueda comprimir antes de enviar en vez de descubrirlo con un error.

### 2.5 · Unificar `/submit` y `/submit-documents`

Los dos recalculan la verificación y devuelven casi lo mismo; `submit-documents` además
responde `400 INCOMPLETE_DOCUMENTS` si faltan. La app usa `/submit`.

**Qué hacer.** Dejar `/submit` como el bueno, hacer que `submit-documents` lo llame por
dentro, y marcarlo como obsoleto en la documentación. **No retirarlo**: lo usan APKs en
la calle.

---

## Fase 3 — Requiere versión nueva de la app

Con el servidor ya listo de las fases 1 y 2.

| # | Tarea | Depende de | Nota |
|---|---|---|---|
| 3.1 | Consumir `required-docs` en las dos pantallas | 2.1 | Resuelve el hallazgo Alta nº 1: desaparecen las dos listas |
| 3.2 | Consumir `config/cities` en el selector de ciudad | 2.2 | Resuelve el hallazgo Alta nº 2: Barranquilla aparece sola |
| 3.3 | Renderizar `SelfieVerificationScreen` y usar `selfieDue`; añadir `cdn.withpersona.com` al CSP | 1.2 | Sin el CSP no carga el SDK aunque se renderice |
| 3.4 | Dejar de imprimir la URL de retorno de OAuth | — | Un `console.log`; es el arreglo más barato de los cuatro Altos |
| 3.5 | Exigir las 4 reglas de contraseña, no 2 de 4 | — | El servidor ya las exige: hoy el usuario escribe una contraseña que la app acepta y el servidor rechaza |
| 3.6 | Mostrar los códigos de error nuevos y usar `action` | 1.4 | `action` dice qué botón ofrecer: iniciar sesión, recuperar contraseña, usar otro correo |
| 3.7 | Enviar `expiryDate` también en el lote de registro | 1.1 | Hoy solo lo manda `upload-doc` |
| 3.8 | Unificar el vocabulario de categorías | 2.3 | |
| 3.9 | Borrar o reconectar el código heredado | — | Pantalla de espera, modo `upload-docs`, rama OTP |

**El orden importa.** 3.4 y 3.5 no dependen de nada y se pueden meter en el próximo
APK; el resto conviene que espere a que las fases 1 y 2 estén desplegadas, para que la
app nueva encuentre los endpoints ya en pie.

---

## Fase 4 — Decisiones de negocio, no técnicas

Ninguna se puede resolver desde el código sin que alguien decida primero.

**Documentos por país.** Los 11 del registro son de Florida: TNC de HSMV, W-9 del IRS,
FMCSA para la prueba de drogas. Un conductor de Barranquilla no puede presentar
ninguno. Hace falta decidir qué se le pide en Colombia antes de que
`required-docs` (§2.1) pueda responder por país. **Bloquea abrir Barranquilla de
verdad**, no sólo poder elegirla en una lista.

**Moneda y huso por zona.** Relacionado y ya documentado en
[`GEOCERCA_INTERNACIONAL.md`](GEOCERCA_INTERNACIONAL.md): hoy se cobra en USD con la
hora de Miami en las dos ciudades.

**`signature` y `concierge`.** Tienen sala de reparto pero no tarifa. O se les pone
precio, o se retiran del reparto.

**Google sin vehículo ni documentos.** Es una decisión de producto: o se le pide el
vehículo en el alta, o se acepta que llegue al panel bloqueado. Hoy el servidor lo
frena correctamente con `NO_VEHICLE`; lo que falla es que la app no le explica por qué.

**Edad mínima.** Se implementó en **21 años** al corregir el registro. Es el estándar
TNC, pero conviene confirmarlo — y decidir si cambia por país.

---

## Orden sugerido

| Tanda | Contenido | Necesita APK |
|---|---|---|
| **1** | 1.1 `expiryDate` · 1.2 `selfieDue` · 1.3 ruta duplicada · 1.4 documentación | No |
| **2** | 2.1 `required-docs` · 2.4 límites · 2.2 `config/cities` | No |
| **3** | 3.4 logs · 3.5 contraseña | Sí, pero sin dependencias |
| **4** | 2.3 categorías · 2.5 unificar submit · 3.1 · 3.2 · 3.6 · 3.7 | Sí |
| **5** | 3.3 Persona · 3.8 · 3.9 | Sí |
| **—** | Fase 4 en paralelo, es conversación | — |

La tanda 1 es la que más cambia por lo poco que cuesta: enciende un sistema de
vencimientos que lleva desde el principio sin funcionar, y no requiere que ningún
conductor actualice nada.

---

## Lo que ya está bien y conviene no tocar

Para que el plan no dé la impresión de que todo está por hacer:

- **Los 19 endpoints del contrato existen y responden.** Incluidos los tres de Stripe
  Connect, que están en [integrations.ts:759-880](../server/api/integrations.ts#L759).
- **La máquina de estados de verificación es una sola fuente de verdad**
  (`recalcularVerificacion`). Antes se escribía desde cinco sitios con criterios
  distintos; eso ya se corrigió.
- **El servidor bloquea de verdad al conectarse**: `NO_VEHICLE` y `NOT_APPROVED` no son
  cosmética de la app.
- **Los errores del alta ya son específicos**: 34 códigos distintos y cero
  `SERVER_ERROR` en toda la ruta, con `field` y `action` para que la app sepa qué
  marcar y qué ofrecer.
- **El lote de documentos informa por archivo**, con el motivo de cada fallo.
