# Empresas con choferes

Contrato para quien construye el panel de URBONT, la web del dispatcher y la web del chofer. El feature todavía no está implementado. Esta página es la regla con la que tienen que coincidir las pantallas.

URBONT es la plataforma. No es una empresa de transporte y no tiene choferes propios. No existe una fila “empresa URBONT”. Toda empresa de este documento es una empresa externa.

Fuente: `Plan.docx` del 11 de octubre de 2026. Donde ese texto se contradice, manda lo que está escrito aquí.

## Reglas que pinta cualquier pantalla

- Un chofer pertenece a una sola empresa. Una empresa tiene muchos choferes.
- Sin empresa, el chofer no toma viajes. En la base `company_id` puede ser null: ese null es el estado “sin empresa”, no un valor prohibido. Poner la columna `NOT NULL` impediría guardar a un chofer bloqueado por no tener empresa.
- Para cambiar de empresa primero se desvincula. Al desvincular queda bloqueado hasta que otra empresa lo afilie.
- Cada empresa tiene un solo dispatcher: el dueño o el responsable. Es un usuario (`profiles.id`) guardado en `companies.dispatcher_user_id`.
- El vehículo sigue en `profiles.vehicle` (JSON, un chofer, un vehículo). No hay tabla de vehículos. La empresa ve el vehículo a través del chofer.
- Las reservas siguen en `rides`, con `scheduled_at`. No hay tabla de reservas.
- Las empresas y los choferes solo suben documentos. URBONT los aprueba o los rechaza desde el panel.
- Un viaje nuevo todavía no tiene chofer. No se puede “buscar la empresa del chofer” en el momento de pedirlo. El viaje se ofrece a los dispatchers de las empresas activas que pueden atender el punto de recogida.

El párrafo inicial del Word (“al chofer afiliado solo se le pide licencia, teléfono y correo, y solo sirve para reservas”) no se implementa. El resto del mismo documento exige licencia, seguro del vehículo, documentos y disponibilidad, y cubre reservas y viajes inmediatos. Se sigue esa versión.

## Qué ya existe y no hay que reinventar

- El chofer es un `profiles` con rol `driver` o `chauffeur`. No hay una tabla `drivers` aparte.
- `rides.scheduled_at` ya guarda la reserva. Hoy, al crearla, se avisa a los choferes cercanos (`notifyNearbyDrivers`) y el primero que acepta se la queda. Eso cambia: el aviso pasa al dispatcher.
- `driver_documents` ya guarda la documentación del chofer, con estados y avisos a 30, 15 y 7 días (`notified_30d`, `notified_15d`, `notified_7d`).
- `GET /api/admin/documents` ya lista esos documentos para el panel. La aprobación de empresas y del seguro comercial es nueva. La aprobación de un documento de chofer se extiende, no se duplica.
- El vehículo ya está en `profiles.vehicle`.

## Estados

Empresa (`companies.status`):

- `pending`: inscrita, esperando que URBONT la apruebe.
- `active`: puede recibir viajes.
- `suspended`: URBONT la suspendió.
- `blocked`: seguro comercial vencido, o contrato sin firmar o rechazado. No recibe viajes nuevos. Ninguno de sus choferes puede tomar viajes. Sí puede subir documentos nuevos. Al quedar el seguro y el contrato aprobados y vigentes, vuelve a `active` sola.

Chofer (columnas nuevas en `profiles`, no un estado que reemplace `account_status`):

- `company_id` null, o `driver_affiliation` = `blocked`: no toma viajes. Motivos: sin empresa, licencia vencida, seguro del vehículo vencido, o su empresa está `blocked` o no está `active`.
- `driver_affiliation` = `active`: puede recibir lo que le asigne su dispatcher.
- `available_for_dispatch` = true o false: el chofer dice si está listo. El dispatcher solo asigna a quien está en true, afiliado y no bloqueado.

El bloqueo de la empresa apaga a todos sus choferes. El bloqueo de un chofer no apaga a los demás.

Viaje (`rides.dispatch_status`):

- `offered`: creado, avisado a los dispatchers, sin empresa que lo haya tomado.
- `assigned`: un dispatcher lo asignó a un chofer de su empresa. Tiene `company_id`, `dispatcher_id`, `driver_id` y `assigned_at`.
- `rejected`: el dispatcher dijo que no tiene chofer. Vuelve a ofrecerse a otra empresa.
- `escalated`: ninguna empresa lo tomó a tiempo. Se avisa al equipo URBONT.
- `accepted`: el chofer aceptó la asignación. A partir de ahí el viaje sigue el flujo actual (`confirmed` y el resto de `ride_status`).

`ride_status` no se reemplaza. `dispatch_status` dice quién debe actuar. `dispatch_required` queda en true en todo viaje nuevo cuando el feature esté encendido.

## Tablas

`companies` (nueva):

- `id`, `name`, `ein`, `contact_email`, `phone`, `address`
- `status`: `pending`, `active`, `suspended`, `blocked`
- `created_at`
- `contract_accepted`, `contract_accepted_at`, `contract_url`, `contract_status`: `pending`, `signed`, `rejected`
- `insurance_policy_number`, `insurance_carrier`, `insurance_starts_at`, `insurance_expires_at`, `insurance_url`
- `insurance_status`: `pending`, `valid`, `expiring`, `expired`, `rejected`
- `insurance_reviewed_at`
- `dispatcher_user_id`: un solo usuario, o null si todavía no hay dispatcher

`insurance_history` (nueva): cada cambio de póliza de una empresa. `company_id`, número, aseguradora, vigencia, archivo, estado, quién lo revisó y cuándo. No se borra la fila anterior.

En `profiles`, para el chofer:

- `company_id` (nullable)
- `driver_affiliation`: `active` o `blocked`
- `available_for_dispatch` (boolean)
- `vehicle_insurance_number`, `vehicle_insurance_expires_at`

La licencia ya está en `drivers_license` y `license_expiry`. El archivo de la licencia sigue siendo un `driver_documents`, no una URL nueva suelta.

En `rides`:

- `dispatch_required`, `dispatch_status`
- `company_id`: la empresa a la que se ofreció o que lo tomó
- `dispatcher_id`, `assigned_at`

No se agrega `company_id` a `driver_documents`. El documento del chofer es de él. El contrato y el seguro comercial viven en `companies`.

## Migración de los choferes que ya existen

El día del deploy no se apaga a los choferes que ya trabajan. Siguen recibiendo viajes como hoy, con `company_id` null y sin bloqueo, hasta una fecha de corte que URBONT tiene que fijar.

En el panel, esos choferes se ven como “sin empresa”. Una empresa activa puede afiliarlos. Después de la fecha de corte, `company_id` null pasa a `driver_affiliation = blocked` y dejan de recibir viajes hasta que una empresa los afilie.

No se hace `UPDATE` masivo inventando una empresa URBONT. Esa empresa no existe.

## Endpoints que va a servir este backend

Todavía no existen. El panel y la web deben llamar estos caminos y estos cuerpos.

Autenticación: el mismo Bearer de Supabase que ya usa el panel. El admin de URBONT entra por las rutas `/api/admin/...`. El dispatcher solo ve su empresa. Un chofer solo ve la suya.

### Empresas

`POST /api/companies`

```json
{
  "name": "Miami Executive Transport LLC",
  "ein": "12-3456789",
  "contactEmail": "ops@example.com",
  "phone": "+13055550100",
  "address": "100 Biscayne Blvd, Miami, FL"
}
```

Responde `201` con la empresa en `status: "pending"`.

`GET /api/companies` lista. `GET /api/companies/:id` detalle, con sus choferes y el vehículo de cada uno (`profiles.vehicle`).

`PUT /api/companies/:id` actualiza nombre, EIN, contacto, teléfono y dirección. No cambia `status`: eso solo lo hace la aprobación o el bloqueo por documentos.

`POST /api/companies/:id/contract` sube el PDF del contrato. `contract_status` pasa a `pending`.

`POST /api/companies/:id/insurance` sube la póliza (número, aseguradora, inicio, vencimiento, archivo). `insurance_status` pasa a `pending` y se agrega una fila a `insurance_history`.

`PUT /api/companies/:id/dispatcher` con `{ "userId": "<profiles.id>" }`. Si ya había otro dispatcher, se reemplaza. Solo puede haber uno.

`POST /api/companies/:id/drivers` con `{ "driverId": "<profiles.id>" }`.

- Si ese chofer ya tiene otra `company_id`, responde `409 ALREADY_AFFILIATED`. Hay que desvincularlo antes.
- Si la empresa no está `active`, responde `409 COMPANY_NOT_ACTIVE`.

`DELETE /api/companies/:id/drivers/:driverId` deja `company_id` null y `driver_affiliation` en `blocked`.

### Dispatcher

Todas exigen que el usuario sea el `dispatcher_user_id` de su empresa, y que la empresa esté `active`.

`GET /api/dispatch/pending` viajes de su empresa con `dispatch_status` `offered`. Cada ítem trae pasajero, recogida, destino, `scheduled_at` (null si es inmediato), vehículo pedido, tarifa y la nota del viaje (`rides.notes`).

`GET /api/dispatch/pending/:id` el mismo detalle de uno.

`GET /api/dispatch/available-drivers` choferes de su empresa con `driver_affiliation = active` y `available_for_dispatch = true`. Cada uno trae nombre, teléfono, correo, licencia, vehículo (`profiles.vehicle`) y la última ubicación.

`GET /api/dispatch/active-drivers` los mismos más los que están en un viaje, marcados `busy` o `available`.

`POST /api/dispatch/assign`

```json
{ "rideId": "<uuid>", "driverId": "<uuid>" }
```

Solo si el chofer es de su empresa, está afiliado, disponible y no bloqueado, y el viaje está `offered` para esa empresa. Escribe `driver_id`, `dispatcher_id`, `assigned_at`, `company_id` y `dispatch_status = assigned`. El chofer recibe el push. Si el chofer no acepta, el viaje no pasa a `confirmed`.

`POST /api/dispatch/reject` con `{ "rideId": "<uuid>" }`. `dispatch_status` pasa a `rejected` y el viaje se ofrece a otra empresa activa.

`GET /api/dispatch/history` asignaciones ya hechas por esa empresa.

### Chofer

`PUT /api/drivers/:id/availability` con `{ "available": true }`. Solo el propio chofer.

`POST /api/drivers/:id/unassign-company` lo desvincula y lo bloquea. Lo usa el panel o la empresa, no el chofer por su cuenta.

La licencia, el seguro del vehículo y el resto de documentos siguen por `POST /api/chauffeur/upload-doc`, que ya existe. Quedan `pending` hasta que el panel los apruebe. No se abre otro camino de subida.

El alta de un chofer nuevo exige `companyId`. Sin empresa no se crea una cuenta que pueda ponerse en línea.

### Panel de URBONT

`GET /api/admin/companies/pending` empresas en `pending`.

`POST /api/admin/companies/:id/approve` la pasa a `active` solo si el contrato está `signed` y el seguro está `valid`. Si falta algo, `409 COMPANY_INCOMPLETE` con `missing`.

`POST /api/admin/companies/:id/reject` con `{ "reason": "..." }`.

`GET /api/admin/insurance/pending` pólizas de empresa en `pending`.

`POST /api/admin/insurance/:id/approve` y `POST /api/admin/insurance/:id/reject`. Al aprobar, si la vigencia es futura, `insurance_status` queda `valid` y un bloqueo por seguro vencido se levanta.

Los documentos del chofer siguen en `GET /api/admin/documents`. Aprobar y rechazar uno sigue siendo el flujo de documentos que el panel ya tiene. Un rechazo avisa al chofer para que lo vuelva a subir.

## Qué tiene que pintar cada sitio

### Panel admin (otro repositorio)

- Lista de empresas con estado: pendiente, activa, suspendida, bloqueada.
- Ficha de empresa: datos, EIN, dispatcher, contrato, seguro, choferes y el vehículo de cada chofer.
- Botones aprobar y rechazar empresa. Aprobar permanece deshabilitado mientras falte contrato firmado o seguro vigente, y muestra el `missing` del `409`.
- Cola de seguros de empresa, distinta de la cola de documentos del chofer.
- Cola de documentos del chofer: la que ya consume `GET /api/admin/documents`.
- Choferes “sin empresa” mientras dure la migración, y choferes bloqueados con el motivo (sin empresa, licencia, seguro del vehículo, empresa bloqueada).
- Asignar o cambiar el dispatcher de una empresa. La pantalla deja un solo usuario.
- Afiliar y desvincular chofer. Si el chofer ya tiene empresa, el botón de afiliar no se ofrece: primero se desvincula.
- Alertas de vencimiento a 30, 15 y 7 días, por empresa y por chofer.

### Web del dispatcher (otro repositorio)

- Entra el usuario guardado en `dispatcher_user_id`. No es un login distinto: es una sesión de ese usuario, y la web solo muestra su empresa.
- Reservas e inmediatos pendientes, en vivo. Un inmediato y una reserva usan la misma lista; la reserva muestra fecha y hora.
- Mapa y lista de sus choferes, con disponible, ocupado y bloqueado.
- Asignar un viaje a un chofer de esa lista. No se puede asignar a un chofer de otra empresa ni a uno que no esté disponible.
- Rechazar un viaje cuando no hay chofer.
- Historial de lo que esa empresa ya asignó.
- La nota del pasajero o del valet (`rides.notes`) se muestra junto al viaje. No es un selector.

### Web del chofer (otro repositorio)

- Invitación por correo de una empresa, alta con esa `companyId`, y formulario de licencia y documentos.
- Estado de cada documento: pendiente, aprobado, rechazado.
- A qué empresa pertenece, o el aviso de que está bloqueado y por qué.
- Interruptor “Estoy disponible”.
- No asigna viajes. Eso es solo del dispatcher.

### App del chofer (este repositorio, más adelante)

- Muestra la empresa, o “Sin empresa” si está bloqueado por eso.
- “Esperando asignación del dispatcher” cuando el viaje todavía no es suyo.
- Push cuando el dispatcher le asigna un viaje, y botón para aceptarlo.
- El mismo interruptor de disponibilidad.
- La subida de licencia y documentos que ya existe.

## Flujo de un viaje

1. El pasajero, o el valet, pide el viaje. Se crea el `ride` como hoy, con `notes` si escribieron algo, y con `dispatch_status = offered`.
2. Se avisa a los dispatchers de las empresas `active` que cubren la recogida. No se avisa a los choferes.
3. Un dispatcher lo ve en su web y elige un chofer disponible de su empresa, o lo rechaza.
4. El chofer recibe el push, acepta, y el viaje sigue como hoy.
5. Si nadie asigna a tiempo, se vuelve a avisar. Si sigue sin respuesta, se ofrece a otra empresa. Si ninguna responde, `dispatch_status = escalated` y se avisa al equipo URBONT.

Los minutos de esa espera quedan en configuración. Propuesta inicial: 5 minutos en un viaje inmediato y 15 en una reserva. El panel no los hardcodea.

Mientras la fecha de corte no llegue, un chofer que todavía no tiene empresa sigue pudiendo aceptar por el aviso actual. Un chofer que ya tiene empresa solo recibe viajes que su dispatcher le asignó.

## Vencimientos

Un cron diario, a las 9:00, mira:

- `companies.insurance_expires_at`
- `profiles.license_expiry`
- `profiles.vehicle_insurance_expires_at`

A 30, 15 y 7 días manda correo y no vuelve a mandar el mismo aviso. El día del vencimiento bloquea a la empresa o al chofer, según de quién sea el documento. Subir una póliza o un documento nuevo lo deja en `pending`. Solo la aprobación de URBONT, con fecha vigente, levanta el bloqueo.

## Lo que el panel no debe hacer

- Crear una empresa llamada URBONT ni colgar choferes de ella.
- Dar de alta un chofer operativo sin `companyId`.
- Asignar un chofer a una segunda empresa sin desvincularlo.
- Poner más de un dispatcher por empresa.
- Aprobar una empresa con el contrato o el seguro todavía pendientes.
- Mandar el viaje nuevo al chofer saltándose al dispatcher, salvo los choferes que la migración todavía deja en el flujo viejo.
- Tratar la nota del viaje como una lista de opciones. Es el texto de `rides.notes`.
