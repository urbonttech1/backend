# Manual técnico URBONT · app móvil

> **Rama:** `chore/split-mobile-only` · **Código:** `a77c37f6`
> Los próximos capítulos se agregan a este mismo documento.

---

## Capítulo 01 · Socios — Creación de perfiles de chofer

Todo lo que pasa desde que un chofer abre el portal hasta que puede ponerse **En
línea**: pantallas en orden, campos que se piden, lo que la app envía y espera del
backend, y lo que queda guardado en el teléfono.

**5** pantallas en la ruta principal · **3** formas de entrar · **15** campos en el
formulario · **11** documentos · **19** endpoints

### Contenido

1. [Resumen](#resumen)
2. [Mapa de pantallas](#mapa-de-pantallas)
3. [Estados de verificación](#estados-de-verificación)
4. [Portal de Chófer](#portal-de-chófer)
5. [Formulario de registro](#formulario-de-registro)
6. [Registro con Google](#registro-con-google)
7. [Panel antes de aprobar](#panel-antes-de-aprobar)
8. [Documentos](#documentos)
9. [Vehículo y cobros](#vehículo-y-cobros)
10. [Verificación de identidad](#verificación-de-identidad)
11. [Datos en el teléfono](#datos-en-el-teléfono)
12. [Sesión y seguridad](#sesión-y-seguridad)
13. [Contrato con el backend](#contrato-con-el-backend)
14. [Código heredado](#código-heredado)
15. [Hallazgos y pendientes](#hallazgos-y-pendientes)
16. [Historial](#historial)

---

## Resumen

El chofer entra por el **Portal de Chófer**. Puede crear su cuenta con correo y
contraseña (formulario de 5 pasos), con Google (sin formulario en la mayoría de los
casos) o volver a entrar con su PIN si guardó el perfil. Todos los caminos terminan
en el **panel de conductor**.

El panel se ve completo, pero el botón de estado dice *Docs Required* y no deja
conectarse hasta que el servidor marca al chofer como `approved`. Un administrador
revisa los documentos desde el panel web; la app vuelve a consultar el estado cada
60 segundos, así que la aprobación aparece sola.

*Fuente principal: `src/screens/chauffeur/` · `src/App/screen-renderer.tsx` · `src/lib/sessionManager.ts`*

---

## Mapa de pantallas

La app navega con un id de pantalla (`currentScreen`). Ésta es la ruta de un chofer
nuevo con correo, y abajo las desviaciones.

```
welcome            →  partner-select      →  chauffeur-login
Bienvenida            Tipo de socio          Portal de Chófer

                   →  chauffeur-registration  →  chauffeur-dashboard
                      Formulario, 5 pasos        Panel de conductor
```

| Desviación | Ruta |
|---|---|
| Con correo y contraseña | `chauffeur-login` → `chauffeur-dashboard` |
| Con Google, cuenta nueva | navegador → `urbont://oauth` → `chauffeur-dashboard` |
| Si el perfil de Google falla | `chauffeur-registration` con el correo prellenado |
| Al reabrir la app con PIN | `pin-lock` → `chauffeur-dashboard` |
| Cerrar sesión | `chauffeur-dashboard` → `welcome` |
| Sesión inválida en pantalla protegida | vuelve a `chauffeur-login` |

| Id | Pantalla | Archivo | Llega desde | Sale hacia |
|---|---|---|---|---|
| `welcome` | Bienvenida | `WelcomeScreen` | Arranque sin sesión, cierre de sesión | Opción de socios → `partner-select` |
| `partner-select` | Tipo de socio | `PartnerSelectScreen` | `welcome` | Chófer → `chauffeur-login` · Valet → `valet-login` |
| `chauffeur-login` | Portal de Chófer | `chauffeur/ChauffeurLoginScreen.tsx` | `partner-select`, retorno de Google con error, sesión inválida | Login → `chauffeur-dashboard` · *Aplicar para unirte* → `chauffeur-registration` |
| `chauffeur-registration` | Formulario de registro | `chauffeur/ChauffeurRegistrationScreen.tsx` | Portal, o retorno de Google si falla el perfil automático | Enviar → `chauffeur-dashboard` · Atrás en paso 1 → `chauffeur-login` |
| `chauffeur-dashboard` | Panel de conductor | `driver/DriverDashboardMobile.tsx` | Login, registro, Google, PIN | Cuenta → Documentos / Vehículo (pestañas internas) · Cerrar sesión → `welcome` |
| `pin-lock` | Bloqueo con PIN | `auth/PinLockScreen.tsx` | Arranque con sesión de chofer y PIN configurado | `chauffeur-dashboard` |

*Fuente: `src/App/screen-renderer.tsx` · `src/App/index.tsx` (arranque y pantallas protegidas)*

---

## Estados de verificación

Todo el flujo gira alrededor de un campo del chofer, `verificationStatus`. Lo decide
el servidor; la app lo copia en `chauffeur_verification_status` y, si falta, asume
`pending_documents`. **Nunca asume `approved` por defecto.**

```
pending_documents  ──docs completos o envío──▶  pending_review  ──admin aprueba──▶  approved
Cuenta creada,                                  Esperando al                        Puede ponerse
faltan documentos                               administrador                       En línea
                                                      │
                                                      └──admin rechaza con motivo──▶  rejected
                                                                                      Ve el motivo
```

Desde `rejected`, el chofer vuelve a subir los documentos corregidos y el servidor lo
regresa a `pending_review`.

| Estado | Qué significa | Quién lo cambia | Qué ve el chofer |
|---|---|---|---|
| `pending_documents` | La cuenta existe pero faltan documentos obligatorios. | Servidor, al crear la cuenta. | Botón *Docs Required*; al tocarlo va a Cuenta → Documentos. |
| `pending_review` | Están todos los documentos obligatorios, o el chofer envió la solicitud. | Servidor, al subir el último documento o con `POST /api/chauffeur/submit`. | Aviso *Documents under review*. No puede conectarse. |
| `approved` | Documentos y vehículo verificados. | Administrador, desde el panel web. | Puede ponerse En línea. |
| `rejected` | Uno o más documentos necesitan corrección. Llega con `rejectionReason`. | Administrador. | Igual que `pending_documents`: aviso y enlace a Documentos. |

**De dónde lee la app el estado**

- Respuesta de `POST /api/chauffeur/login` y de `POST /api/chauffeur/oauth-login`.
- `GET /api/chauffeur/verification-status` al abrir el panel y cada 60 segundos
  mientras está abierto.
- Respuestas de `submit`, `documents` y `upload-doc` cuando el servidor confirma el
  paso a `pending_review`.
- La copia local al reabrir la app, hasta que llega la del servidor.

*Fuente: `DriverDashboardMobile.tsx` · `refreshVerificationStatus` · `sessionManager.ts` · `getChauffeurStatus()`*

---

## Portal de Chófer

Pantalla `chauffeur-login`. Tiene tres modos: formulario de correo y contraseña,
botón *Continuar con Google* y, si el chofer guardó su perfil antes, un teclado de PIN.

### Campos

| Campo | Clave | Obligatorio | Validación en la app |
|---|---|---|---|
| Correo electrónico | `email` | Sí | Formato `x@y.z`; se envía sin espacios |
| Contraseña | `password` | Sí | No vacía |
| Recordarme | `rememberMe` | No | Activado por defecto |
| PIN (acceso rápido) | `pin` | No | 4 dígitos; 5 intentos y bloqueo de 15 minutos |

**`POST /api/chauffeur/login`** — sin token · límite de 12 s

La app envía:

```json
{
  "email": "chofer@correo.com",
  "password": "••••••••"
}
```

La app espera:

```jsonc
{
  "session": { "access_token", "refresh_token" },
  "user": {
    "id", "email", "phone", "firstName", "lastName",
    "vehicle", "rating", "avatar_url", "membership",
    "title", "date_of_birth"
  },
  "verificationStatus": "pending_documents",
  "rejectionReason": null,
  "operatingCity": "Miami, FL"
}
```

| Error (`errorCode`) | Qué pasó | Qué muestra la app |
|---|---|---|
| `ACCOUNT_LOCKED` / 429 | Demasiados intentos fallidos | Cuenta regresiva con `lockedUntilSec` (900 s si no llega) |
| `EMAIL_NOT_FOUND` | No hay cuenta de chofer con ese correo | *Account not found*, invita a registrarse |
| `WRONG_PASSWORD` | Contraseña incorrecta | Si `attemptsLeft` ≤ 2, avisa que casi se bloquea |
| `ACCESS_DENIED` | El correo es de una cuenta de pasajero | *Wrong account type* |
| `MISSING_FIELDS` | Faltan datos | Mensaje del servidor; marca el campo de `field` |
| `RATE_LIMITED` | Límite de peticiones | *Too many requests* |
| Sin respuesta en 12 s / sin red | — | *Request timed out* o *No internet connection* |

### Después de entrar

- Guarda la sesión y el perfil en `chauffeur_session`, y el estado en
  `chauffeur_verification_status`.
- Con *Recordarme*, pide `GET /api/users/pin` y guarda correo, nombre, id y hash del
  PIN en `urbont_driver_session`.
- Recupera el PIN del servidor, activa el rol `chauffeur` y abre siempre
  `chauffeur-dashboard`.

### Olvidé mi contraseña

Usa el correo escrito en el formulario y llama a
`supabase.auth.resetPasswordForEmail`. El chofer recibe un enlace; al volver, la app
lo manda al portal.

*Fuente: `src/screens/chauffeur/ChauffeurLoginScreen.tsx`*

---

## Formulario de registro

Pantalla `chauffeur-registration` en modo `register`. Una bienvenida sin número y
cinco pasos con barra *Step N of 5*. Los pasos con llamada al servidor solo avanzan si
responde bien, salvo Documentos. *Atrás* en el paso 1 vuelve al portal.

### Paso 0 · Bienvenida

Beneficios del programa: *Top rates — avg. $38/hr in Miami*, horario propio, clientela
VIP y verificación de antecedentes. No pide datos ni llama al servidor.

### Paso 1 · Personal

| Campo en pantalla | Clave | Obligatorio | Validación | Se envía en |
|---|---|---|---|---|
| First Name | `firstName` | Sí | No vacío | `register` / `complete-profile` |
| Last Name | `lastName` | Sí | No vacío | `register` / `complete-profile` |
| Mobile Number | `phone` | Sí | No vacío; ejemplo `(305) 000-0000` | `register` / `complete-profile` |
| Date of Birth | `dob` | Sí | Selector de fecha, no vacío | `register` / `complete-profile` |

No llama al servidor: los datos quedan en el borrador y se envían en el paso 2.

### Paso 2 · Cuenta

| Campo en pantalla | Clave | Obligatorio | Validación | Se envía en |
|---|---|---|---|---|
| Email Address | `email` | Sí\* | Formato de correo | `register` |
| Password | `password` | Sí\* | Al menos 2 de 4: 8+ caracteres, mayúscula, número, símbolo | `register` |
| Confirm Password | `confirmPw` | Sí\* | Igual a la contraseña; no se envía | — |
| Operating City | `city` | Sí | Una de 20 ciudades de EE. UU. (Miami, Fort Lauderdale, Boca Raton, West Palm Beach, Tampa, Orlando, Jacksonville, Nueva York, Los Ángeles, Chicago, Houston, Phoenix, San Diego, Dallas, San Francisco, Seattle, Denver, Washington, Boston, Atlanta) | `register` · `set-city` |
| Business Name (optional) | `businessName` | No | Texto libre | `register` / `complete-profile` |

\* Si el chofer viene de Google, el correo llega prellenado y no se piden contraseña
ni confirmación.

**`POST /api/chauffeur/register`** — sin token · botón *Create Account*

La app envía:

```jsonc
{
  "firstName", "lastName", "email", "phone",
  "dob", "password", "city", "businessName"
}
```

La app espera:

```jsonc
{ "session": { "access_token" } }   // o "token"

// error
{ "error", "errorCode": "EMAIL_IN_USE", "field": "email" }
```

Guarda el token en `chauffeur_session` y, como respaldo, repite la ciudad:

**`POST /api/chauffeur/set-city`** — Bearer · errores ignorados

```json
{ "city": "Miami, FL" }
```

Si viene de Google, en lugar de `register` llama a
`POST /api/chauffeur/complete-profile` con el token de Google y
`{ firstName, lastName, phone, dob, city, businessName }`.

### Paso 3 · Vehículo

| Campo en pantalla | Clave | Obligatorio | Opciones |
|---|---|---|---|
| Categoría | `category` | Sí | `SUV` o `Sedan` |
| Marca | `make` | Sí | De la lista aprobada de la categoría |
| Modelo | `model` | Sí | SUV: Escalade, Escalade ESV, Suburban, Tahoe, Yukon, Yukon Denali, Yukon XL, Expedition, Navigator, Navigator L. Sedan: Clase E, Clase S, Serie 5, Serie 7, A6, A7, A8, GS, LS, XTS, CT6, Continental, G80, G90 |
| Año | `year` | Sí | 2021 a 2026 |
| Color | `color` | Sí | Black, White, Silver, Midnight Blue, Champagne, Charcoal |
| License Plate | `plate` | Sí | Texto libre; ejemplo `ABC-1234` |

**`POST /api/chauffeur/set-vehicle`** — Bearer · botón *Save Vehicle*

La app envía:

```json
{
  "category": "SUV", "make": "Cadillac",
  "model": "Escalade", "year": "2025",
  "color": "Black", "plate": "ABC-1234"
}
```

La app espera:

```jsonc
// 2xx para avanzar
// error
{ "error": "…" }
```

### Paso 4 · Documentos

Los 11 documentos de la lista de registro, en 4 categorías. Cada uno se carga con la
cámara (en el teléfono usa el plugin Camera de Capacitor) o como archivo, imagen o
PDF. Se envían todos juntos como data URLs. Este paso es **opcional**: sin documentos
avanza, y si la subida falla avisa y avanza igual.

| Clave | Documento | Categoría | Indicación en pantalla |
|---|---|---|---|
| `license` | Driver's License | Personal Identity | Front & back, clearly visible |
| `photo` | Profile Photo | Personal Identity | Professional headshot, no sunglasses |
| `bgCheck` | Background Check Consent | Personal Identity | Signed authorization form |
| `registration` | Vehicle Registration | Vehicle Documents | Proof of ownership, must match vehicle |
| `insurance` | Personal Auto Insurance | Vehicle Documents | Current policy, FL state minimum |
| `commercialInsurance` | Commercial Auto Insurance | Vehicle Documents | Required for TNC operations in FL |
| `inspection` | Vehicle Inspection | Vehicle Documents | Annual safety inspection certificate |
| `tncPermit` | TNC / Chauffeur Permit | Professional Credentials | Florida HSMV or local authority permit |
| `defensiveDriving` | Defensive Driving Cert. | Professional Credentials | Completed within last 3 years |
| `w9` | Tax Form W-9 | Legal & Compliance | Required for IRS reporting |
| `drugTest` | Drug Test Results | Legal & Compliance | FMCSA 10-panel test, within 30 days |

**`POST /api/chauffeur/documents`** — Bearer · botón *Submit Documents*

La app envía:

```json
{
  "documents": {
    "license": "data:image/jpeg;base64,…",
    "w9": "data:application/pdf;base64,…"
  }
}
```

La app espera:

```jsonc
{ "verificationStatus": "pending_review" }  // opcional

// error
{ "error": "…" }
```

### Paso 5 · Revisión

Resumen en cuatro bloques: Personal (nombre, teléfono, fecha de nacimiento), Account
(correo, ciudad, empresa), Vehicle (año, marca, modelo, categoría, color, placa) y
Documents (*Uploaded N of 11* y cuántos faltan). Al enviar:

**`POST /api/chauffeur/submit`** — Bearer · sin body

```json
{ "verificationStatus": "pending_review" }
```

Si la red falla, la app asume `pending_review` igual, porque el servidor fija ese
estado al recibir la solicitud. Borra el borrador, guarda el estado y abre
`chauffeur-dashboard`.

#### Borrador local

Cada cambio se guarda en `chauffeur_registration_draft`. Al volver a abrir la pantalla
restaura campos y paso (del 1 al 5, nunca la bienvenida). Si el borrador tiene más de
24 horas, lo descarta. Los documentos solo se restauran si son data URLs válidas.
Existe porque en Android abrir la cámara puede reiniciar la actividad y perder el
estado.

#### Errores del formulario

| Situación | Mensaje | ¿Avanza? |
|---|---|---|
| Campo obligatorio vacío | *Required · Please fill in all required fields.* | No, marca los campos |
| Correo ya registrado (`EMAIL_IN_USE`) | *Email already registered* | No, marca el correo |
| Vehículo incompleto | *Incomplete · Please fill in all vehicle details.* | No |
| Sin red en Cuenta o Vehículo | *Network error* | No |
| Falla la subida de documentos | *Documents not saved · Your profile was saved…* | Sí |

*Fuente: `src/screens/chauffeur/ChauffeurRegistrationScreen.tsx`*

---

## Registro con Google

Con Google, una cuenta nueva normalmente **no pasa por el formulario**: se crea con el
nombre de Google y va directo al panel.

### Secuencia

- **OAuth.** *Continuar con Google* abre la selección de cuenta de Supabase. En el
  teléfono guarda `urbont_pending_oauth_role = chauffeur`, abre el navegador del
  sistema y vuelve por `urbont://oauth`. En web vuelve con `?oauth=chauffeur`.
- **Consulta al servidor** con el token de Google.

**`POST /api/chauffeur/oauth-login`** — sin Bearer, token en el body

La app envía:

```json
{ "accessToken": "<token de Supabase>" }
```

La app espera:

```jsonc
{
  "needsRegistration": false,
  "session": { "access_token" },
  "verificationStatus", "rejectionReason",
  "user": { "id", "email", "firstName", "lastName" },
  "userId", "email"
}
```

| Respuesta | Qué hace la app |
|---|---|
| Error (p. ej. correo de pasajero) | Vuelve a `chauffeur-login` y muestra el `error` del servidor 7 segundos. |
| Cuenta de chofer existente | Guarda sesión y estado, activa el rol y abre el panel. |
| `needsRegistration: true` | Llama a `complete-profile` con nombre y apellido de Google, marca `urbont_driver_needs_name` y abre el panel. **No pide vehículo ni documentos.** |
| `complete-profile` falla | Abre `chauffeur-registration` con el correo prellenado; en el paso 2 usa `complete-profile`. |

**`POST /api/chauffeur/complete-profile`** — Bearer con el token de Google

La app envía (automático):

```json
{ "firstName": "Ana", "lastName": "Pérez" }
```

La app espera:

```json
{
  "session": { "access_token" },
  "verificationStatus": "pending_documents"
}
```

Si quedó marcado `urbont_driver_needs_name`, el panel pide nombre y apellido en un
modal y los envía otra vez a `complete-profile` con `{ firstName, lastName }`.

*Fuente: `src/App/realtime-hooks.ts` (retorno de `urbont://oauth`) · `DriverDashboardMobile.tsx` (modal de nombre)*

---

## Panel antes de aprobar

El chofer ve el panel completo. El botón de estado dice *Docs Required* hasta que el
estado es `approved`. Al tocarlo:

- Con `pending_review`: aviso *Documents under review*, sin más.
- Con `pending_documents` o `rejected`: aviso *Documents required* y cambia a la
  pestaña Cuenta → Documentos.

**`GET /api/chauffeur/verification-status`** — Bearer · al abrir y cada 60 s

```json
{
  "verificationStatus": "pending_review",
  "uploadedDocs": { "license": { "status": "approved", "storage_url": "…" } }
}
```

**`GET /api/drivers/verification-status`** — Bearer · al abrir

```json
{
  "isBlocked": false, "blockReason": null,
  "selfieDue": false, "priorityScore": 1.0,
  "acceptanceRate": 0.92, "needsReview": false
}
```

Si llega `isBlocked`, el panel muestra el bloqueo con `blockReason`.

> **El servidor también bloquea**
>
> Según el contrato de backend, `PATCH /api/drivers/status` con
> `{ "is_online": true }` responde 403 con `errorCode` `NO_VEHICLE` si no hay
> vehículo, o `NOT_APPROVED` si la cuenta no está aprobada. El bloqueo de la app es la
> primera barrera, no la única.

*Fuente: `DriverDashboardMobile.tsx` · `handleToggleOnline` · contrato URBONT API §3.1*

---

## Documentos

Después del registro, los documentos se cargan uno por uno desde **Cuenta →
Documentos**, con fecha de vencimiento cuando aplica. El estado de cada uno sale de
`uploadedDocs`; un documento `approved` se muestra como *verified*.

**`POST /api/chauffeur/upload-doc`** — Bearer

La app envía:

```json
{
  "docKey": "limoPermit",
  "fileName": "limoPermit_1789170000000.pdf",
  "mimeType": "application/pdf",
  "base64": "data:application/pdf;base64,…",
  "expiryDate": "2027-03-31"
}
```

La app espera:

```json
{
  "success": true,
  "storageUrl": "…",
  "verificationStatus": "pending_review"
}
```

El servidor pasa el estado a `pending_review` solo cuando están todos los
obligatorios; la app lo actualiza al recibirlo. La fecha de vencimiento también se
guarda localmente en `chauffeur_doc_expiry`.

> ⚠️ **Dos listas distintas**
>
> El registro y Cuenta → Documentos piden **11 documentos cada uno, pero no los
> mismos**. Solo coinciden 6 claves, e `insurance` es seguro personal en una lista y
> comercial en la otra. El aviso del panel dice "upload all 11 required documents" sin
> decir cuáles.

| Solo en el registro | En ambas listas | Solo en Cuenta → Documentos |
|---|---|---|
| `bgCheck` — Consentimiento de antecedentes | `license` — Licencia | `limoPermit` — Permiso limo Miami-Dade |
| `commercialInsurance` — Seguro comercial | `photo` — Foto profesional | `airportPermit` — Permiso aeropuerto MIA |
| `tncPermit` — Permiso TNC de Florida | `registration` — Registro del vehículo | `portPermit` — Permiso puerto de Miami |
| `defensiveDriving` — Manejo defensivo | `insurance` — Seguro (distinto) | `corpFiles` — Documentos de empresa |
| `drugTest` — Prueba de drogas | `inspection` — Inspección | `taxId` — Tax ID |
| | `w9` — Formulario W-9 | |

*Fuente: `ChauffeurRegistrationScreen.tsx` (DOCS) · `driver/components/ProfileTab.tsx` (DOC_LIST)*

---

## Vehículo y cobros

### Editar vehículo

Desde Cuenta → Vehículo. Guardar exige marca, modelo y año. Un 401 significa sesión
vencida; un 403, que la cuenta no es de chofer.

**`PATCH /api/drivers/vehicle`** — Bearer

La app envía:

```jsonc
{
  "make", "model", "year",
  "color", "plate", "category"
}
```

La app espera:

```jsonc
{ "success": true, "vehicle": { … } }

// error
{ "error": "…" }
```

**`POST /api/drivers/vehicle-photo`** — Bearer

```jsonc
{ "mimeType": "image/jpeg", "base64": "data:image/jpeg;base64,…" }
// respuesta
{ "success": true, "photoUrl": "…" }
```

### Cobros con Stripe Connect

La tarjeta de pagos del panel tiene tres estados: sin conectar, pendiente y activa. No
es requisito para la aprobación, pero según el contrato de backend la transferencia del
90 % al chofer solo ocurre con Stripe Connect activo.

| Método | Ruta | Cuándo | Respuesta que usa |
|---|---|---|---|
| GET | `/api/integrations/stripe/connect/status` | Al mostrar la tarjeta | `{ status: "active" \| "pending" \| … }` |
| POST | `/api/integrations/stripe/connect/create-account` | Botón conectar | `{ onboardingUrl }`, se abre en el navegador |
| POST | `/api/integrations/stripe/connect/dashboard-link` | Cuenta activa | `{ url }` |

*Fuente: `driver/components/ProfileTab.tsx` · `components/StripeConnectCard.tsx`*

---

## Verificación de identidad

`SelfieVerificationScreen` implementa una verificación KYC con Persona: SDK 4.9.0 desde
`cdn.withpersona.com` y plantilla en `VITE_PERSONA_TEMPLATE_ID` (si contiene "sandbox"
usa el entorno de pruebas). Tiene tres motivos: semanal, por viajes completados y al
iniciar sesión.

**`POST /api/drivers/selfie-verify`** — Bearer

```json
{ "trigger": "weekly" | "trips" | "login", "inquiryId": "inq_…", "status": "completed" }
```

> ⚠️ **No está conectada**
>
> Ninguna pantalla renderiza `SelfieVerificationScreen`, y el panel recibe `selfieDue`
> pero no lo usa. Además, el CSP de `index.html` no permite scripts de
> `cdn.withpersona.com`, así que el SDK no cargaría aunque la pantalla apareciera.

*Fuente: `src/screens/driver/SelfieVerificationScreen.tsx` · `index.html`*

---

## Datos en el teléfono

Lo que la app guarda en `localStorage` durante el flujo. Sirve para depurar y para
entender por qué una pantalla abre con cierto estado.

| Clave | Contenido | La escribe | La lee |
|---|---|---|---|
| `chauffeur_session` | `access_token`, `refresh_token` y perfil (`id`, `email`, `phone`, `first_name`, `last_name`, `vehicle`, `rating`, `avatar_url`, `membership`…) | Login, registro, Google, refresco de token | Todas las llamadas del chofer, pantallas protegidas |
| `chauffeur_verification_status` | Uno de los 4 estados | Login, Google, registro, panel (cada 60 s) | Arranque, panel, PIN |
| `chauffeur_rejection_reason` | Motivo del rechazo | Login, Google | Arranque |
| `chauffeur_registration_draft` | Campos del formulario, paso, documentos y `_savedAt` (caduca a las 24 h) | Formulario, en cada cambio | Formulario, al abrir |
| `urbont_driver_session` | Correo, nombre, id y hash del PIN | Login con Recordarme | Portal (acceso con PIN) |
| `urbont_pending_oauth_role` | `chauffeur` | Portal, antes de abrir Google en el teléfono | Retorno de `urbont://oauth` (se borra al leer) |
| `urbont_oauth_in_progress` | `true` mientras el navegador está abierto | Portal | Retorno de Google |
| `urbont_driver_needs_name` | `true` | Auto-registro con Google | Panel (modal de nombre, luego se borra) |
| `chauffeur_doc_expiry` | Fecha de vencimiento por documento | Cuenta → Documentos | Cuenta → Documentos |
| `urbont_driver_online_intent` | `true` / `false` | Botón En línea | Panel al reconectar |

En `sessionStorage`, el portal guarda además `urbont_oauth_context = chauffeur-login`
antes de abrir Google.

---

## Sesión y seguridad

- La sesión de chofer es independiente de la de pasajero (`urbont_supabase_session`) y
  la de valet (`valet_session`).
- `chauffeur-dashboard` y `chauffeur-pending` están protegidas: sin sesión, o si el
  token no trae rol `chauffeur` o `admin`, la app borra la sesión y abre
  `chauffeur-login`.
- Si el chofer tiene PIN configurado, la app abre `pin-lock` al arrancar.
- Cerrar sesión limpia la sesión y el PIN del chofer y abre `welcome`.

*Fuente: `src/App/index.tsx` (`CHAUFFEUR_PROTECTED`) · `src/lib/sessionManager.ts`*

---

## Contrato con el backend

Todos los endpoints que toca el flujo de chofer. Base `https://api.urbont.com`.
"Bearer" es el `access_token` de `chauffeur_session`, salvo que se indique otro token.

| Método | Ruta | Auth | Body que envía la app | Respuesta que usa |
|---|---|---|---|---|
| POST | `/api/chauffeur/login` | — | `email, password` | `session, user, verificationStatus, rejectionReason, operatingCity` · error `errorCode, field, attemptsLeft, lockedUntilSec` |
| POST | `/api/chauffeur/oauth-login` | — | `accessToken` | `needsRegistration, session, verificationStatus, rejectionReason, user, userId, email` |
| POST | `/api/chauffeur/register` | — | `firstName, lastName, email, phone, dob, password, city, businessName` | `session.access_token` o `token` · error `EMAIL_IN_USE, field` |
| POST | `/api/chauffeur/complete-profile` | Google | `firstName, lastName` (+ `phone, dob, city, businessName` desde el formulario) | `session, verificationStatus` |
| POST | `/api/chauffeur/set-city` | Bearer | `city` | — |
| POST | `/api/chauffeur/set-vehicle` | Bearer | `category, make, model, year, color, plate` | 2xx · error `error` |
| POST | `/api/chauffeur/documents` | Bearer | `documents: { docKey: dataURL }` | `verificationStatus` (opcional) |
| POST | `/api/chauffeur/submit` | Bearer | — | `verificationStatus` |
| POST | `/api/chauffeur/upload-doc` | Bearer | `docKey, fileName, mimeType, base64, expiryDate` | `success, storageUrl, expiryDate, verificationStatus` |
| GET | `/api/chauffeur/required-docs` | — | — | `docs[{key,label,category,hint,expires}], totalRequired, acceptedMimeTypes, maxFileBytes, maxBatchBytes` |
| GET | `/api/config/cities` | — | — | `cities[{id,name,region,country,timezone,zoneId}], default` |
| GET | `/api/config/vehicle-categories` | — | — | `categories[{key,label,aliases,bookable,minFare,perHour}]` |
| GET | `/api/chauffeur/verification-status` | Bearer | — | `verificationStatus, uploadedDocs{ status, storage_url }` |
| GET | `/api/drivers/verification-status` | Bearer | — | `isBlocked, blockReason, selfieDue, priorityScore, acceptanceRate, needsReview` |
| PATCH | `/api/drivers/status` | Bearer | `is_online` | 403 `NO_VEHICLE` / `NOT_APPROVED` |
| PATCH | `/api/drivers/vehicle` | Bearer | `make, model, year, color, plate, category` | `success, vehicle` |
| POST | `/api/drivers/vehicle-photo` | Bearer | `mimeType, base64` | `success, photoUrl` |
| POST | `/api/drivers/selfie-verify` | Bearer | `trigger, inquiryId, status` | 2xx |
| GET | `/api/users/pin` | Bearer | — | `pinHash` |
| GET | `/api/integrations/stripe/connect/status` | Bearer | — | `status` |
| POST | `/api/integrations/stripe/connect/create-account` | Bearer | — | `onboardingUrl` |
| POST | `/api/integrations/stripe/connect/dashboard-link` | Bearer | — | `url` |

> ✅ **Pedido resuelto el 2026-09-13**
>
> `GET /api/chauffeur/required-docs` ya existe y es público. Devuelve las once
> claves con su etiqueta, categoría, ayuda y si caducan, más los tipos de archivo
> admitidos y los límites de tamaño. Cuando las dos pantallas lo consuman, dejan de
> poder contradecirse.
>
> También son nuevos `GET /api/config/cities` —que ya incluye Barranquilla— y
> `GET /api/config/vehicle-categories`, con los alias de cada categoría.

### Códigos de error del alta, actualizados el 2026-09-13

La tabla de §Formulario de registro documenta `EMAIL_IN_USE`, que era el contrato
correcto pero **no llegaba nunca**: el servidor detectaba el correo duplicado
comparando texto y el mensaje real de Supabase no casaba, así que devolvía un `500`
genérico. Ya está corregido, y con él llegaron más códigos:

| `errorCode` | Cuándo | `action` |
|---|---|---|
| `EMAIL_IN_USE` | Ya hay cuenta de chofer con ese correo | `login` |
| `EMAIL_IN_USE_OTHER_ROLE` | El correo es de un valet o un pasajero. Trae `existingRole` | `use_different_email` |
| `UNDERAGE` · `INVALID_DOB` | Fecha de nacimiento inválida o menor de 21 | — |
| `INVALID_PHONE` · `INVALID_CITY` | Formato del teléfono o ciudad vacía | — |
| `INVALID_YEAR` | Año del vehículo fuera de 1980–(año actual + 1) | — |
| `DOCUMENT_EXPIRED` | El documento subido ya venció | — |
| `PROFILE_SAVE_FAILED` | La cuenta se creó pero el perfil no. Trae `accountCreated: true` | `login` |
| `AUTH_SERVICE_UNAVAILABLE` | No se pudo hablar con el servicio de cuentas | `retry` |
| `VEHICLE_SAVE_FAILED` · `CITY_SAVE_FAILED` · `SUBMIT_FAILED` · `UPLOAD_FAILED` | Fallo al guardar cada paso | `retry` |

Todos traen `field` cuando el problema es de un campo concreto, y `action` dice qué
ofrecer: iniciar sesión, recuperar contraseña, usar otro correo o reintentar. **Ya no
existe `SERVER_ERROR` en ninguna ruta del alta.**

---

## Código heredado

Estas piezas siguen en el código, pero hoy ningún camino las abre:

- **`chauffeur-pending` (`ChauffeurPendingScreen`).** Pantalla de espera con cinco
  etapas: Registro, Verificación de documentos, Aprobación de vehículo, Presentación y
  entrega de kit, y Tutorial en video, con el botón *Verificar estado*. Solo se
  mostraría si el destino tras el login fuera `chauffeur-pending`, pero
  `getPostLoginScreen` siempre devuelve el panel.
- **Modo `upload-docs` del formulario.** Abría el formulario directamente en
  Documentos, y solo se llega a él desde la pantalla de espera.
- **Registro por código OTP.** `screen-renderer` todavía manda al formulario de chofer
  después de verificar un código, pero ningún botón del portal pasa por esa pantalla.

---

## Hallazgos y pendientes

Lo que apareció al documentar este flujo. Nada de esto se ha cambiado todavía.

| Severidad | Hallazgo | Detalle |
|---|---|---|
| **Alta** | Dos listas de 11 documentos que no coinciden | El registro pide requisitos de Florida y Cuenta → Documentos pide permisos de Miami-Dade. Hace falta una sola lista, idealmente servida por el backend. |
| **Alta** | Barranquilla no se puede elegir como ciudad | La ciudad operativa sale de una lista fija de 20 ciudades de EE. UU., aunque Barranquilla ya es zona activa en el servidor. |
| **Alta** | Verificación de identidad sin conectar | La pantalla de Persona no se muestra en ningún lado, `selfieDue` se ignora y el CSP bloquearía el SDK. |
| **Alta** | Token de sesión en los logs | Al volver de Google, la app imprime en consola la URL `urbont://oauth#access_token=…`, visible en logcat. |
| **Media** | Categorías de vehículo distintas | El registro ofrece `SUV` y `Sedan`; el editor de Cuenta → Vehículo usa `executive`, `suv`, `van` y `signature`. |
| **Media** | Requisitos solo de EE. UU. | Textos en inglés con referencias a FL, HSMV, IRS W-9 y FMCSA, en una app traducida al español que opera en Colombia. |
| **Media** | Google se salta vehículo y documentos | La cuenta nueva llega al panel sin vehículo, y el servidor la bloquea con `NO_VEHICLE` hasta que lo cargue desde Cuenta. |
| **Media** | Contraseña débil permitida | Basta con cumplir 2 de 4 reglas, así que puede pasar una contraseña de menos de 8 caracteres aunque el campo diga "Min. 8 characters". |
| **Media** | Documentos en base64 dentro de JSON | En el registro los 11 archivos pueden ir en una sola petición. Conviene confirmar el límite de tamaño del body en el servidor. |
| **Baja** | Código heredado | La pantalla de espera, el modo `upload-docs` y la rama OTP de chofer ya no tienen entrada. Se pueden borrar o volver a conectar. |

---

## Historial

| Fecha | Cambio |
|---|---|
| 11 sep 2026 | Capítulo 01: creación de perfiles de chofer. Basado en el código de `a77c37f6`. |

---

*Documentado a partir del código de la app móvil. El comportamiento del servidor se
describe según lo que la app espera y el contrato de API compartido por backend.*
