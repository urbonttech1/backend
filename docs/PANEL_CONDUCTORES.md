# Panel de Conductores — contrato de datos

`GET /api/admin/drivers` · requiere token de admin · respuesta `{ "drivers": [...] }`

Este documento describe los campos que devuelve el endpoint después de unificar
la información de conductores, y qué debe pintar el panel con cada uno.

---

## 1. El problema que se corrigió

El panel mostraba a un conductor como **aprobado** y al mismo tiempo con
**documentos rechazados**. Ninguna de las dos lecturas era un error del panel:
había tres campos distintos describiendo lo mismo, y no coincidían entre sí.

| Fuente | Dónde vive | Vocabulario que usa |
|---|---|---|
| `verification_status` | `profiles` | `approved`, `pending_documents` |
| `background_check.status` | `profiles` (JSONB) | `approved`, `cleared`, `not_submitted`, ausente |
| Documentos reales | tabla `driver_documents` | `valid`, `approved`, `pending`, `rejected` |

Tres de diez conductores tenían las fuentes en desacuerdo. Además
`driver_documents` usa **dos palabras para el mismo estado** (`valid` y
`approved`), lo que hacía que cualquier conteo saliera partido en dos.

El endpoint ahora normaliza ese vocabulario y expone **un estado derivado de los
documentos reales**, conservando las otras dos fuentes para poder auditarlas.

---

## 2. Estado de documentos: usar `documentsState`

Es el único campo calculado a partir de `driver_documents`. **Este es el que
debe mandar en el panel.** Se resuelve como el peor de los estados
individuales: basta un documento rechazado para que el conductor quede en
`rechazado`.

| Valor | Significado | Sugerencia visual |
|---|---|---|
| `aprobado` | todos los documentos aprobados | verde |
| `pendiente` | hay documentos sin revisar, ninguno rechazado | ámbar |
| `rechazado` | al menos uno rechazado | rojo |
| `sin_documentos` | nunca subió ninguno | gris |

Acompañado de los conteos, para el detalle:

```json
"documentsState":    "rechazado",
"documentsApproved": 1,
"documentsPending":  8,
"documentsRejected": 2,
"documentsTotal":    11,
"rejectionReason":   "Please re-upload the requested document."
```

### Los documentos uno por uno

`documents` trae cada archivo del conductor, ya ordenado por tipo, para que la
ficha del conductor no tenga que pedir `/api/admin/documents` aparte y filtrar:

```json
"documents": [
  {
    "id": "4541d1cc-d74d-4d69-ad5a-564de484e6c8",
    "docKey": "airportPermit",
    "state": "aprobado",
    "rawStatus": "approved",
    "fileName": "airportPermit_1783631580678.jpg",
    "url": "https://….supabase.co/storage/v1/object/public/chauffeur-docs/…/airportPermit.jpg",
    "uploadedAt": "2026-07-07T00:59:18.12+00:00",
    "updatedAt": "2026-09-08T01:43:38.463+00:00",
    "required": true
  }
]
```

`state` usa el mismo vocabulario que `documentsState`; `rawStatus` es el valor
crudo de la columna, por si hace falta auditarlo. `required: false` marca un
documento subido que no pertenece a ningún esquema vigente — no cuenta para la
aprobación, pero se muestra igual para que el admin sepa que existe.

Para aprobar o rechazar desde la ficha se usan los endpoints de siempre, con el
`id` de cada documento:

```
POST /api/admin/documents/:id/approve
POST /api/admin/documents/:id/reject          { "notes": "motivo" }
POST /api/admin/documents/:id/request-reupload { "reason": "motivo" }
```

Los tres recalculan el estado del conductor al terminar, así que basta con
recargar `/api/admin/drivers` para ver el resultado.

`sin_documentos` y `pendiente` **no son lo mismo**: el primero es un registro
que nunca empezó, el segundo uno que espera revisión. Conviene distinguirlos.

---

## 3. Banderas de inconsistencia

Tres booleanos que marcan datos que no deberían poder existir. Si alguno es
`true`, el panel debería señalarlo en vez de mostrar el dato como normal.

| Campo | Qué significa |
|---|---|
| `verificationMismatch` | El perfil dice `approved` pero sus documentos no, o al revés |
| `approvedWithoutVehicle` | Quedó aprobado sin vehículo registrado |
| `roleMismatch` | Maneja viajes pero su perfil no tiene rol de conductor |

Para auditar el desacuerdo se exponen las tres fuentes sin tocar:

```json
"verificationStatus":    "pending_documents",   // profiles.verification_status
"backgroundCheckStatus": "approved",            // profiles.background_check.status
"documentsState":        "rechazado"            // derivado de driver_documents
```

---

## 4. Viajes y dinero

Los conteos ya **no** salen del contador `total_rides` del perfil: se cuentan
contra la tabla `rides`.

| Campo | Qué es |
|---|---|
| `ridesCompleted` | viajes completados |
| `ridesCancelled` | viajes cancelados |
| `ridesAssigned` | total que tuvo asignados (completados + cancelados + otros) |
| `lastRideAt` · `lastRide` | fecha del último viaje completado, o `null` |
| `earnings` | lo que gana el conductor: el neto. Es lo que rotula "Ganancias" |
| `earningsGross` | suma de tarifas de sus viajes completados |
| `earningsNet` | lo mismo que `earnings` |
| `totalRidesCounter` | el contador guardado en el perfil |
| `rides` | sus viajes, del más reciente al más antiguo |

### La pestaña de viajes

`rides` existe porque la ficha del conductor tenía una pestaña "Viajes" sin
ningún endpoint al que llamar: no había forma de pedir los viajes de un
conductor. Viene en la misma respuesta, con los mismos nombres que usa
`/api/admin/rides`:

```json
"rides": [
  {
    "id": "1c34e672-8c91-47e7-b9cc-57f7c6295a7d",
    "date": "2026-09-07T19:43:30.731",
    "status": "cancelled",
    "passenger": "+19547135475",
    "origin": "12431 SW 7th Ct, Davie, FL 33325, USA",
    "destination": "4700 S Flamingo Rd, Cooper City, FL 33330, EE. UU.",
    "fare": 35.67,
    "totalPrice": null,
    "tipAmount": null,
    "distanceMiles": 3.7326,
    "durationMinutes": 8,
    "vehicleType": "sedan",
    "paymentMethod": "card",
    "paymentStatus": "pending",
    "rating": null,
    "cancelReason": "wrong_pickup",
    "completedAt": null,
    "cancelledAt": "2026-09-07T19:44:50.092+00:00"
  }
]
```

La lista trae **todos** sus viajes, no solo los completados: los cancelados son
la mayoría y sirven para entender su desempeño. `ridesCompleted` cuenta solo los
completados, así que el número del encabezado y el largo de la lista no
coinciden — y está bien, miden cosas distintas.

**La estadística que ve el usuario debe ser `ridesCompleted`**, y conviene
etiquetarla como "completados": mostrar solo un número junto a una lista de
viajes que incluye cancelados es lo que hacía parecer que las cifras no
cuadraban.

`totalRidesCounter` existe únicamente para detectar desincronización: si difiere
de `ridesCompleted`, el contador se desactualizó. Hoy coinciden en los diez.

`earningsGross` y `earningsNet` son **cálculos sobre las tarifas**, no pagos
confirmados. Los pagos reales están en Stripe.

---

## 5. Vehículo

El vehículo viene desglosado, no solo como cadena armada:

```json
"vehicle":         "Cadillac Escalade 2024",
"vehicleMake":     "Cadillac",
"vehicleModel":    "Escalade",
"vehicleYear":     "2024",
"plate":           "DN89RU",
"vehicleColor":    "",
"vehiclePhotoUrl": "https://.../vehicle_1783280088959.jpg",
"hasVehicle":      true
```

Los campos sueltos existen porque el panel mostraba "Año: —" aunque el dato
estuviera: leía la cadena armada en vez del campo. `vehicleYear` es texto, no
número, porque así está guardado en la base.

Usar `hasVehicle` para decidir si mostrar la sección, en lugar de comprobar si
la cadena está vacía.

---

## 6. Campos que se conservan

`verified` y `docsStatus` siguen saliendo con el mismo significado de antes
(ambos derivados de `background_check.status`) para no romper el panel actual.
**No usarlos en pantallas nuevas**: describen una fuente que no refleja los
documentos reales. Reemplazarlos por `documentsState`.

---

## 7. Ejemplo completo

```json
{
  "id": "5a6b079e-cc20-43f6-9006-118899e77fea",
  "name": "Ciro Vargas",
  "email": "cvc@oohg.org",
  "phone": "17864165121",
  "role": "passenger",
  "status": "offline",
  "accountStatus": "active",
  "rating": 5,

  "ridesCompleted": 7,
  "ridesCancelled": 5,
  "ridesAssigned": 12,
  "lastRideAt": "2026-08-02T16:32:21.047+00:00",
  "lastRide": "2026-08-02T16:32:21.047+00:00",
  "earnings": 217.38,
  "earningsGross": 241.53,
  "earningsNet": 217.38,
  "totalRidesCounter": 7,
  "rides": [ /* ver sección 4 */ ],

  "vehicle": "Cadillac Escalade 2024",
  "vehicleMake": "Cadillac",
  "vehicleModel": "Escalade",
  "vehicleYear": "2024",
  "plate": "DN89RU",
  "vehicleColor": "",
  "vehiclePhotoUrl": "https://.../vehicle_1783280088959.jpg",
  "hasVehicle": true,

  "documentsState": "aprobado",
  "documentsApproved": 11,
  "documentsPending": 0,
  "documentsRejected": 0,
  "documentsTotal": 11,
  "documents": [ /* ver sección 2 */ ],
  "rejectionReason": null,
  "verificationStatus": "approved",
  "backgroundCheckStatus": "approved",

  "verificationMismatch": false,
  "approvedWithoutVehicle": false,
  "roleMismatch": true,

  "joinedDate": "2026-07-04",
  "createdAt": "2026-07-04T12:34:49.381+00:00",
  "membership": "free",
  "operatingCity": "",
  "commissionRate": 10,
  "stripeConnectStatus": "not_connected",
  "priorityScore": 1,

  "verified": true,
  "docsStatus": "approved"
}
```

---

## 8. Estado actual de los datos

Diez conductores. Lo que devuelve el endpoint hoy:

| Conductor | documentsState | verification | vehículo | completados | ¿puede conectarse? |
|---|---|---|---|---|---|
| Ciro Vargas | aprobado | approved | sí | 7 | sí |
| leo lamanna | aprobado | approved | sí | 3 | sí |
| Ricardo Lopez | aprobado | approved | sí | 0 | sí |
| **Carlos Urbont** | **sin_documentos** | **approved** | sí | 0 | **sí** |
| **Hefeusto Randall** | **sin_documentos** | **approved** | **no** | 0 | no |
| Miguel Conductor | sin_documentos | pending_documents | sí | 0 | no |
| Martin Lenovo | sin_documentos | pending_documents | no | 0 | no |
| Carlos Martinez | sin_documentos | pending_documents | no | 0 | no |
| Ciro Test | sin_documentos | pending_documents | no | 0 | no |
| Test Crash | sin_documentos | pending_documents | no | 0 | no |

Solo 4 de 10 tienen algún documento cargado. Los dos en negrita están aprobados
sin haber subido ninguno; Carlos Urbont además puede conectarse, porque tiene
vehículo. Los once documentos de Ciro Vargas se aprobaron el 7 de septiembre de
2026 para desbloquearlo, incluidos dos que un revisor había rechazado.

---

## 9. Flujo de registro de conductor

Ocho pasos. Todo cuelga de `/api/chauffeur` salvo el estado en línea.

| # | Paso | Endpoint |
|---|---|---|
| 1 | Alta | `POST /api/chauffeur/register` (o `/oauth-login` + `/complete-profile`) |
| 2 | Vehículo | `POST /api/chauffeur/set-vehicle` |
| 3 | Ciudad | `POST /api/chauffeur/set-city` |
| 4 | Documentos | `POST /api/chauffeur/upload-doc` × 11, o `/documents` por lote |
| 5 | Envío a revisión | `POST /api/chauffeur/submit-documents` |
| 6 | Revisión del admin | `POST /api/admin/documents/:id/approve` · `/reject` |
| 7 | Consulta de estado | `GET /api/chauffeur/verification-status` |
| 8 | Conectarse | `PATCH /api/drivers/status` con `is_online: true` |

El alta **no** pide vehículo ni documentos: se cargan después. El control está
en el paso 8, que devuelve `403` mientras el conductor no esté aprobado:

```json
{ "error": "Debes registrar tu vehículo antes de conectarte.", "errorCode": "NO_VEHICLE" }
{ "error": "Tu cuenta aún no está aprobada.",                  "errorCode": "NOT_APPROVED" }
```

Así el registro queda sin fricción y el requisito se aplica donde importa.

---

## 10. Cómo se calcula el estado

Un único servicio, `server/services/driverVerification.ts`, es el **único que
escribe `verification_status`**. Antes lo escribían cinco lugares con criterios
distintos: dos marcaban `pending_review` sin comprobar nada — uno con que se
guardara un solo archivo, otro sin mirar absolutamente nada — y el de admin
contaba filas en vez de tipos de documento.

`recalcularVerificacion(driverId)` se invoca al subir un documento, al enviarlos
a revisión, al registrar el vehículo y al aprobar o rechazar desde el panel.
Resuelve en este orden:

```
algún documento requerido rechazado   → 'rejected'
falta algún tipo requerido            → 'pending_documents'
están todos pero sin revisar          → 'pending_review'
todos aprobados y sin vehículo        → 'pending_documents' + motivo
todos aprobados y con vehículo        → 'approved'
```

Conviven **dos juegos de documentos**, ambos de once tipos, y el servicio evalúa
a cada conductor contra el que haya empezado:

| | Tipos |
|---|---|
| **Vigente** (`REQUIRED_DOC_KEYS`) — lo que piden hoy la app y el signup web | `license`, `photo`, `bgCheck`, `registration`, `insurance`, `commercialInsurance`, `inspection`, `tncPermit`, `defensiveDriving`, `w9`, `drugTest` |
| **Anterior** (`LEGACY_DOC_KEYS`) — esquema de limusina | `limoPermit`, `airportPermit`, `inspection`, `portPermit`, `insurance`, `registration`, `corpFiles`, `w9`, `taxId`, `license`, `photo` |

Las dos listas solo comparten seis nombres, así que evaluar a todos contra una
sola dejaría a la mitad de los conductores con "faltan once documentos". Quien
completó el esquema anterior sigue contando como alta completa; a los nuevos
solo se les pide el vigente. `ACCEPTED_DOC_KEYS` es la unión y es contra lo que
se validan las cargas.

Los estados `valid` y `approved` de `driver_documents` eran la misma cosa
escrita con dos palabras, y el conteo del panel solo miraba una: un conductor
con los once documentos revisados podía no aprobarse nunca. Ahora se escribe
`approved` en todos los casos, y las filas históricas ya se normalizaron.

---

## 11. Lo que queda pendiente

Decisiones de producto o de datos, no de la capa de lectura:

1. **Los dos esquemas de documentos conviven indefinidamente.** El backend
   soporta ambos, pero mantener dos listas es deuda: hay que decidir si a los
   conductores del esquema anterior se les pide migrar al vigente, y en tal caso
   retirar `LEGACY_DOC_KEYS`. Hoy son dos de los diez.
2. **Los estados históricos no se han recalculado.** El código nuevo es correcto
   de aquí en adelante, pero los perfiles existentes conservan su valor viejo
   hasta que alguien toque uno de sus documentos. El recálculo cambiaría dos:
   Hefeusto Randall y Carlos Urbont pasarían de `approved` a `pending_documents`,
   porque están aprobados sin un solo documento cargado. Ninguno de los dos ha
   manejado nunca, así que el recálculo no deja a nadie sin trabajar.
3. **Perfiles duplicados.** El mismo teléfono guardado con y sin `+` genera dos
   perfiles distintos (caso "ciro vargas" / "Ciro Vargas"). No hay normalización
   a E.164 en ninguna parte del backend.
4. **`trips_completed`** es una columna muerta: nadie la lee ni la escribe, y
   difiere del conteo real. Conviene eliminarla.
5. **Hay un aspirante invisible al panel**, "Pasaporte Criollo", con un
   documento cargado pero sin rol de conductor. El filtro actual no lo muestra.
6. **Los documentos son públicos.** El bucket `chauffeur-docs` sirve los
   archivos sin firma ni autenticación: una petición anónima a la URL devuelve
   `200`. Cualquiera con el enlace ve licencias, identificaciones fiscales y
   resultados de exámenes médicos. Las rutas son adivinables —
   `/chauffeur-docs/<uuid del conductor>/<docKey>.jpg` — y el uuid viaja en
   varias respuestas del API. Debería pasarse a bucket privado con URLs
   firmadas de vida corta, generadas por el backend al abrir la ficha.
