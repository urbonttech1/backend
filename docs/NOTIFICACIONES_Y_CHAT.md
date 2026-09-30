# Notificaciones push y chat — cambios del 29/09/2026

Qué cambió en el backend, por qué, y qué hay que hacer para ponerlo en producción.

Punto de partida: el push de iOS **nunca había funcionado** (faltaba todo el lado
nativo, que se arregló en el repo de la app). Al quedar iOS operativo por primera
vez, varias decisiones de envío que daban igual mientras solo existía Android
pasaron a importar.

---

## 1. Entrega FCM: tres ejes en vez de uno

`server/services/fcm.ts`

Antes las dos funciones de envío repetían la misma configuración fija: `priority:
'high'` para todo, sin cabeceras APNs y con `badge: 1` incrustado. Ahora hay un
único constructor, `deliveryOptions()`, con tres decisiones **independientes**:

| Eje | Qué hace | Tipos |
|---|---|---|
| `HIGH_PRIORITY_TYPES` | Entrega inmediata en vez de agrupada por batería | ofertas, estados de viaje, chat, cobro fallido, SOS |
| `TIME_SENSITIVE_TYPES` | Atraviesa modo Concentración / No molestar en iOS | ofertas, llegada del chofer, cobro fallido, SOS |
| `EPHEMERAL_TYPES` | Caduca a los 60 s en vez de encolarse | **solo** ofertas de viaje |

Conflatar los tres era el error: un mensaje de chat necesita entrega inmediata
pero **no puede caducar**, y una oferta de viaje necesita las dos cosas.

### Decisiones que conviene no revertir sin leer esto

- **Las ofertas de viaje no se agrupan.** FCM solo mantiene 4 claves de colapso
  pendientes por dispositivo. Agrupar ofertas haría que un conductor perdiera
  trabajo en silencio. Sí se agrupan los estados de un viaje y el chat, en grupos
  separados (`ride_<id>` y `chat_<id>`) para que una llegada no borre un mensaje
  sin leer.
- **Ya no se manda `badge`.** Estaba fijo en `1`, así que el icono llevaba un "1"
  permanente que no correspondía a nada y nunca se limpiaba. Contar no-leídas de
  verdad exige que el cliente las resetee: es otro trabajo.
- **`apns-push-type: alert` va siempre.** Sin esa cabecera iOS puede tratar el
  mensaje como un despertar silencioso y no mostrarlo nunca. Es lo que hace que
  la notificación aparezca con la app en segundo plano o cerrada.
- **`interruption-level` se envía aunque la app no lo soporte.** iOS lo ignora si
  el binario no está firmado con el entitlement *Time Sensitive Notifications*,
  así que mandarlo no rompe nada. Si se quiere que funcione, hay que añadir ese
  entitlement en el repo de la app — puede invalidar el perfil de firma, así que
  se dejó fuera a propósito.

Cubierto por `server/services/fcm.test.ts` (9 casos).

---

## 2. Notificaciones nuevas

### 2.1 Mensajes de chat — `chat_message`

`server/api/translation.ts`, `server/services/socketService.ts`

El chat solo viajaba por socket, o sea que **una app en segundo plano no recibía
nada**. Era la forma más habitual de perderse a un chofer preguntando dónde estás.

Ahora, tras guardar y emitir el mensaje, se envía push al que **no** lo mandó.

Se omite el push si el destinatario ya tiene un socket en la sala de chat del
viaje (`isUserWatchingChat`): está mirando la conversación y el banner sobraría.
Cualquier fallo en esa comprobación cae del lado de **enviar** — un banner de más
molesta menos que un mensaje que nadie ve.

Tampoco se notifica si el viaje ya está `completed` o `cancelled`.

Es `void` + `try/catch`: un push fallido **nunca** puede tumbar el envío del
mensaje, que ya está guardado y emitido antes de llegar aquí.

### 2.2 Reservas del conductor — `driver_reminder_24h`, `driver_reminder_1h`

`server/jobs/cron.ts`

Los recordatorios de 24 h y 1 h los recibía **solo el pasajero**. Un chofer que
aceptó una reserva hace tres días se enteraba con el aviso de "sal ya"
(`scheduled_depart`), dentro de la ventana de despacho.

Ahora el conductor asignado recibe los mismos avisos, reusando el mismo reclamo
atómico (`reminder_24h_sent` / `reminder_1h_sent`), así que no hay duplicados
aunque corran varias instancias.

### 2.3 Cobros fallidos — `payment_failed`, `subscription_past_due`

`server/api/integrations.ts`

Los webhooks `payment_intent.payment_failed` e `invoice.payment_failed`
actualizaban la base de datos y **no avisaban a nadie**. El comentario del código
decía *"so the passenger can be notified"*, pero no había notificación: el
pasajero se enteraba cuando su siguiente reserva fallaba.

Los `update` ahora devuelven el `passenger_id` / `user_id` con `.select()` y se
notifica. Si el `select` no devolviera fila, el update sigue ocurriendo y solo se
pierde el aviso.

---

## 3. Transcripción y traducción de notas de voz

`server/services/voiceTranscription.ts` (nuevo)

El texto del chat se traducía; las notas de voz **no**. El que la recibía oía un
idioma que quizá no habla, y el lector en voz alta del chofer las saltaba porque
no había texto que leer.

### Flujo

```
POST /speak con voiceNoteId
   │
   ├─ guarda la fila y emite por socket      ← inmediato, no espera a la IA
   ├─ manda el push ("🎤 Voice message")
   └─ [async] transcribirYTraducir()
         ├─ descarga del bucket privado ride-chat-audio
         ├─ OpenAI Whisper  → transcript
         ├─ translateText()  → transcript_translated
         ├─ UPDATE ride_chats
         └─ socket 'chat:message_updated'
```

**El audio no espera a la IA.** El que graba ya recibió su respuesta y el que
escucha ya tiene el audio; la transcripción lo alcanza uno o dos segundos después
y parchea la fila. Un cliente que no reciba ese evento muestra la nota sin
transcripción, exactamente como antes.

### Por qué Whisper y no `/v1/audio/translations`

La API de traducción de audio de OpenAI **solo traduce hacia inglés**. URBONT
necesita es ↔ en ↔ fr ↔ pt, así que se transcribe primero y se traduce después
con el mismo modelo de chat que ya usa el texto.

### Credencial

Reusa la clave de OpenAI que ya administra el panel (`translationConfig`). **No
hay una segunda credencial que mantener.** Sin clave, la nota se queda sin
transcribir y no falla nada.

Opcional: `OPENAI_TRANSCRIBE_MODEL` (por defecto `whisper-1`).

### `original_text` no se toca

Sigue valiendo `'Voice message'`. Es lo que distingue una nota de un mensaje
escrito en las vistas previas de la bandeja y en el cliente; cambiarlo rompería
las dos. La transcripción vive en columnas nuevas.

---

## 4. Migración de base de datos

En `server/db/migrations.ts`, idempotente:

```sql
ALTER TABLE ride_chats
  ADD COLUMN IF NOT EXISTS transcript            TEXT,
  ADD COLUMN IF NOT EXISTS transcript_translated TEXT;
```

Se aplica sola al arrancar. No requiere paso manual ni ventana de mantenimiento:
son columnas nuevas anulables.

---

## 5. Contrato con la app

### Campos nuevos en `GET /api/translation/messages/:rideId`

```jsonc
{
  "transcript":            "Estoy llegando al punto de recogida",  // null si no se transcribió
  "transcript_translated": "I'm arriving at the pickup point"      // null si no hizo falta
}
```

### Evento de socket nuevo

```jsonc
// 'chat:message_updated'
{ "rideId": "...", "id": "123", "transcript": "...", "transcriptTranslated": "..." }
```

### Tipos de notificación nuevos

`chat_message` · `driver_reminder_24h` · `driver_reminder_1h` ·
`payment_failed` · `subscription_past_due`

Ya enrutados en la app (`src/lib/notificationRouter.ts`). Un tipo que el cliente
no conozca no se pierde: cae en el `default` del router y usa `data.screen`.

---

## 6. Qué falta

Identificado y **no** hecho, por orden de impacto:

1. **19 de 34 plantillas de `notificationTemplates.ts` están muertas.** Los textos
   reales se escriben a mano en el sitio de llamada y **no coinciden** con la
   plantilla (`"You're picked up! 🚗"` vs `"Driver on the way!"`). Hay que
   unificar **antes** de traducir, o se traducirán 19 textos que nadie ve y se
   dejarán sin traducir los que sí se envían.
2. **Idioma.** Todo sale en inglés. Hace falta `profiles.locale` y traducir en
   servidor: en segundo plano el sistema operativo pinta el texto tal cual llega,
   el cliente no puede traducirlo.
3. **Preferencias por categoría.** No existe ninguna tabla; no se puede
   desactivar nada.
4. **Canales de Android por categoría.** Todo va por `urbont_rides`.
5. **Badge real.** Requiere que el cliente resetee el contador.

### Seguridad: `/speak` sin autenticar es intencionado

`POST /api/translation/speak` **no lleva middleware de autenticación, y así se
queda** (decisión del 29/09/2026). No es un descuido: no lo añadas sin hablarlo
antes, porque el cliente puede no estar mandando el token en ese endpoint y lo
romperías.

Lo que eso implica, para que esté por escrito: cualquiera que conozca un `rideId`
puede inyectar mensajes en ese chat y, desde estos cambios, disparar
notificaciones push y consumir cuota de OpenAI transcribiendo audios. El `rideId`
es un UUID y no se publica, así que en la práctica hace falta filtrarlo primero.

Si algún día se revisa, el cambio es añadir `requireSupabaseAuth` al router —
verificando antes que la app manda `Authorization` en `/speak`.

---

## 7. Cómo probar

1. Desplegar. **No hay CI/CD**: el push a `master` solo escribe un resumen en
   GitHub Actions, el despliegue a ECS es manual.
2. Comprobar que `FIREBASE_SERVICE_ACCOUNT` está en el entorno. Sin ella,
   `fcm.ts` registra *"push notifications disabled"* y **no envía nada**.
3. Comprobar que la clave de OpenAI está cargada en el panel, o las notas no se
   transcriben.
4. Chat en segundo plano: mandar un mensaje con la app del otro **cerrada del
   todo**. Tiene que llegar el banner.
5. Nota de voz: grabar y ver que la transcripción aparece uno o dos segundos
   después de que el audio ya se pueda reproducir.

---

## 8. Commits

```
fe19cce  feat(chat): transcribir y traducir las notas de voz
9414487  feat(push): avisar del cobro fallido de un viaje o de la membresia
d7f14b7  feat(push): recordar al conductor sus reservas 24h y 1h antes
01fa490  feat(push): notificar los mensajes de chat con la app en segundo plano
376a483  fix(push): separar prioridad, urgencia y caducidad en la entrega FCM
e83afa6  feat(push): ajustar la entrega FCM por urgencia para iOS y Android
```

De paso, el backend quedó en **0 errores de `tsc`**: `translation.ts` arrastraba
un TS2353 porque `broadcastChatMessage` recibía `targetLang` sin declararlo.
