# Documentación requerida del valet

La sección **Required Documentation** vive dentro del registro de valet que ya existía (Personal, compañía, cuenta, documentación). No hay un alta aparte.

El texto del acuerdo versión `ivpa-2026-10-1` es un **borrador operativo**. Cubre negocio independiente, responsabilidad propia dentro de la ley, limitación de responsabilidad e indemnificación de URBONT. No sustituye la revisión de un abogado. Para cambiarlo se edita `server/services/valetAgreement.ts` y se publica otra versión: quien ya firmó la anterior tiene que aceptar la nueva. El hash SHA-256 del texto queda guardado con la firma, así que el texto viejo no se reescribe.

Los valets que ya estaban activos no se apagan. En el panel se ven con acuerdo pendiente y W-9 sin archivo. Las cuentas nuevas no se activan hasta completar el paquete.

## Compañía

Obligatorios antes de crear la cuenta:

- Nombre legal (`legalName`)
- Nombre comercial (`tradeName`, también se acepta `businessName`)
- Tipo de empresa: `llc`, `corporation`, `sole_proprietorship`, `partnership`, `other`
- Dirección (`companyAddress`)
- Teléfono de la compañía (`companyPhone`)
- Correo de la compañía (`companyEmail`)

Opcional: representante autorizado (`authorizedRep`).

Se guardan en `profiles` (`company_legal_name`, `business_name`, `company_entity_type`, `company_address`, `company_phone`, `company_email`, `company_rep_name`) y se copian a `valet_applications`.

`POST /api/valet/register` y `POST /api/valet/complete-profile` responden `400 COMPANY_INCOMPLETE` si falta algo. Una cuenta ya creada y todavía en revisión puede completarlos con `POST /api/valet/company` y el token de revisión.

## Acuerdo y firma electrónica

`GET /api/valet/agreement` (sin sesión) devuelve `version`, `title`, `text` y `sha256`.

`POST /api/valet/agreement/accept` exige la sesión del valet y este cuerpo:

```json
{ "version": "ivpa-2026-10-1", "checkbox": true, "action": "i_agree" }
```

Sin la casilla, sin `i_agree` o con otra versión responde `400 AGREEMENT_REQUIRED`. Cada aceptación inserta una fila en `valet_agreement_acceptances` y no borra las anteriores. La fila guarda:

- `user_id` y el correo de la cuenta
- nombre del valet en ese momento (`valet_name`)
- `accepted_at`
- `agreement_version` y `agreement_sha256` del texto exacto
- `checkbox_confirmed` y `action` (`i_agree`), que es el registro de que pulsó el botón
- IP y user agent, si la petición los trae

Al guardar se envía una copia por correo. `GET /api/valet/agreement/copy` descarga `urbont-valet-agreement.txt`: el texto más el registro de la firma.

En la app, el botón **I AGREE – Electronic Signature** permanece deshabilitado hasta marcar la casilla. Pulsarlo crea la cuenta (si aún no existe) y llama a `accept`.

## W-9

El catálogo del valet pide `license`, `photo` y `w9` (IRS Form W-9, PDF o foto, máximo 10 MB). La semilla se inserta en `valet_document_catalog` al arrancar, sin pisar lo que el panel haya editado.

El W-9 no usa la URL pública de `chauffeur-docs`. Se guarda en el bucket privado `valet-tax` y en `driver_documents.storage_url` queda `valet-tax:<ruta>`. `POST /api/chauffeur/upload-doc` no devuelve `storageUrl` para ese archivo. El estado inicial es `received`.

Estados:

- sin archivo, o rechazado: `missing`
- `received`: recibido, aún sin abrir
- `pending_review`: el panel lo marcó en revisión
- `approved`: aprobado

`POST /api/admin/valets/:id/w9` con `{ "status": "received" | "pending_review" | "approved" }` cambia ese estado. Presentar el archivo basta para salir de Pending Documentation. Aprobarlo sigue siendo parte de la revisión, igual que el documento de identidad y la foto.

## Estados en el panel

`GET /api/admin/valets` agrega `documentation` en cada valet:

- `agreement`: `accepted` o `pending`
- `agreementVersion` y `agreementAcceptedAt`
- `w9`: `missing`, `received`, `pending_review` o `approved`
- `w9Url`: URL firmada de una hora, o `null`. No es una URL pública.
- `accountDocumentation`: `pending_documentation` o `ready`

`status` de la cuenta no cambia: sigue siendo `pending`, `active`, `suspended` o `rejected`.

`ready` significa que hay compañía, acuerdo de la versión vigente y W-9 presentado. `active` solo lo pone el panel al aprobar.

`POST /api/admin/valets/:id/approve` responde `409 DOCUMENTATION_INCOMPLETE` si falta la compañía, el acuerdo vigente o el W-9. El cuerpo trae `missing`. El flag `force` no salta esta regla. Una solicitud que todavía no tiene perfil (`id` que empieza por `app:`) tampoco se puede activar: el valet tiene que terminar Required Documentation en la app.

Los documentos de identidad siguen exigiendo aprobación. Sin ellos, y sin `force: true`, la respuesta sigue siendo `409 DOCS_INCOMPLETE`.

## Login en revisión

Si la cuenta está pendiente, `POST /api/valet/login` y `POST /api/valet/oauth-login` siguen respondiendo `403 ACCOUNT_PENDING`. Si el expediente no está `ready` o hay documentos por corregir, la respuesta incluye `uploadToken`, `documentsRequested` y `documentation`. Ese token no abre el portal: sirve para `POST /api/valet/company`, `POST /api/valet/agreement/accept` y volver a subir archivos. La pantalla de inicio de sesión del valet muestra esa sección; no hay otra ruta de registro.
