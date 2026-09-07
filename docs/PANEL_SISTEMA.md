# Pantalla Sistema — ajustes en el panel de administración

Especificación para el equipo del panel (`urbont-admin`). Varios indicadores de esa
pantalla muestran datos que el backend nunca envió. El endpoint ya fue corregido;
acá está qué campos usar y cómo mostrarlos.

**Endpoint:** `GET /api/admin/system` · requiere token de administrador
**Backend:** [`server/api/admin.ts`](../server/api/admin.ts) · [`server/services/systemMetrics.ts`](../server/services/systemMetrics.ts) · [`server/services/integrationChecks.ts`](../server/services/integrationChecks.ts)

---

## Qué está mal hoy

| Tarjeta | Muestra | Problema |
|---|---|---|
| **Memoria en uso** | 39 MB · **85% del total** | El 85% es `heapUsed / heapTotal`, el llenado del heap de Node. V8 amplía el heap cuando se llena, así que ese número vive cerca del 90% **siempre**. El uso real es 6% del contenedor. |
| **Uso de CPU** | `0.0%` | El backend **nunca envió un campo de CPU**. El 0.0% es el valor por defecto de un campo inexistente. La gráfica plana en cero tiene el mismo origen. |
| **Redis Cache** | Conectado ✅ | El backend **nunca envió el estado de Redis**, y no hay ningún Redis desplegado. El check verde es inventado. |
| **Req/minuto**<br>**Tiempo respuesta** | `—` | Tampoco existen en la respuesta. El guion es correcto; las tarjetas no aportan nada. |
| **Base de datos**<br>**Supabase** | Dos tarjetas separadas | Suenan a dos sistemas distintos, pero son **la misma base** consultada por dos caminos. Confunde: alguien que vea una roja y otra verde creerá que tiene dos bases. |
| **Infobip** | Sin configurar | La integración **no existe**: no había código de Infobip en el proyecto. Se eliminó del backend y del panel. Todos los SMS salen por Twilio. |

**Por qué importa más de lo que parece.** Un indicador inventado es peor que no tener
indicador. La barra ámbar del 85% hace pensar que el servidor está al límite cuando usa
el 6%, y el check verde de Redis afirma que funciona algo que no existe. Nadie revisa lo
que el panel declara sano.

---

## Respuesta del endpoint

Los campos antiguos siguen ahí: nada se rompe si el panel no se toca de inmediato.

```jsonc
{
  "uptime": 16533,
  "uptimeFormatted": "4h 35m 33s",

  "memory": {
    "usedMb": 63,        // NUEVO · memoria real del contenedor
    "limitMb": 1024,     // NUEVO · límite asignado
    "percent": 6.2,      // NUEVO · usar ESTE en la barra

    "heapUsedMb": 39,    // diagnóstico, no capacidad
    "heapTotalMb": 46,

    "rss": 63,           // campos antiguos, se mantienen
    "heapUsed": 39,
    "heapTotal": 46
  },

  "cpu": {               // NUEVO · bloque completo
    "percent": 1.7,      // % del vCPU asignado · null en la primera lectura
    "vcpu": 0.5
  },

  "nodeVersion": "v22.23.2",
  "environment": "production",

  "apiStatus": {
    // Comprobados en vivo, en cada llamada
    "database": "connected",
    "supabase": "connected",
    "redis": "not_configured",

    // Verificados al arrancar el servidor, con resultado guardado
    "stripe": "connected",
    "google_maps": "connected",
    "firebase": "not_configured",
    "twilio": "connected",
    "email": "connected"
  },

  // NUEVO · detalle completo de LAS OCHO comprobaciones, con la misma forma.
  // `details` es lo que se muestra al pasar el cursor por la tarjeta.
  "integrations": {
    "stripe": {
      "status": "connected",
      "summary": "Cobros habilitados · producción",      // va en la tarjeta
      "probe": "GET https://api.stripe.com/v1/account",   // cómo se verificó
      "latencyMs": 663,
      "verifiedAt": "2026-09-07T15:25:17Z",
      "details": [                                        // filas del tooltip
        { "label": "Cuenta",             "value": "Urbont technology inc" },
        { "label": "ID",                 "value": "acct_1TCplCQUi64j4EEw" },
        { "label": "Modo",               "value": "Producción (live)" },
        { "label": "País",               "value": "US" },
        { "label": "Moneda",             "value": "USD" },
        { "label": "Cobros habilitados", "value": "Sí" },
        { "label": "Pagos habilitados",  "value": "Sí" },
        { "label": "Respuesta",          "value": "HTTP 200 · 663 ms" }
      ]
    },

    "google_maps": { /* misma forma */ },
    "firebase":    { /* misma forma */ },
    "twilio":      { /* misma forma */ },
    "email":       { /* misma forma */ },

    // Las tres locales tienen exactamente la misma forma
    "database": {
      "status": "connected",
      "summary": "Conexión directa activa",
      "probe": "SELECT 1 · conexión Postgres directa",
      "latencyMs": 42,
      "verifiedAt": "2026-09-07T16:40:02Z",   // siempre reciente: se comprueba en vivo
      "details": [
        { "label": "Proveedor",  "value": "Supabase" },
        { "label": "Acceso",     "value": "Conexión Postgres directa (pooler)" },
        { "label": "Servidor",   "value": "db.rvlafaebvlrtrfdtcbut.supabase.co" },
        { "label": "Motor",      "value": "PostgreSQL 17.6" },
        { "label": "Conexiones", "value": "1 abiertas · 1 libres" },
        { "label": "En cola",    "value": "0" },
        { "label": "Respuesta",  "value": "42 ms" }
      ]
    },

    "supabase": { /* misma forma · "Acceso": "API REST (PostgREST)" */ },
    "redis":    { /* misma forma */ }
  },

  // Atajos planos, para renderizar la tarjeta sin recorrer el objeto
  "verifiedAt":  { "stripe": "2026-09-07T15:25:17Z", "...": "..." },
  "checkDetail": { "stripe": "Cobros habilitados · producción", "...": "..." }
}
```

---

## Cambios tarjeta por tarjeta

### Memoria en uso — corregir el cálculo

```diff
- pct = memory.heapUsed / memory.heapTotal   // 85%
+ pct = memory.percent                       // 6.2%
```

Mostrar `{usedMb} MB` y debajo `{percent}% de {limitMb} MB`.

Umbrales sugeridos: verde bajo 70%, ámbar de 70 a 85%, rojo por encima.

### Uso de CPU — campo nuevo

```diff
- data.cpu ?? 0                          // campo inexistente → 0.0%
+ cpu.percent === null ? '—' : `${cpu.percent}%`
```

**Puede venir `null`** en la primera lectura tras un reinicio: el cálculo necesita dos
muestras. Mostrar `—`, nunca `0.0%`. Los mismos umbrales que la memoria.

### Redis Cache — dato inventado

Leer `apiStatus.redis`. Hoy devuelve `not_configured`, que es la verdad: no hay Redis
desplegado. Solo dirá `connected` cuando el adaptador de Socket.IO se haya conectado de
verdad, no por tener la variable puesta.

Alternativa válida: **quitar la tarjeta** hasta que Redis exista. Hará falta al pasar a
dos contenedores.

### Req/minuto y Tiempo respuesta — sin dato

Siguen sin existir en el backend. **Quitar ambas tarjetas** o dejarlas con `—` y una nota
de «no disponible». Implementarlas requiere un contador de peticiones en el servidor: es
trabajo aparte, no un ajuste de panel.

### Base de datos y Supabase — renombrar

Las dos tarjetas apuntan al **mismo proyecto de Supabase**. Lo que cambia es el camino:

| Campo | Cómo consulta | Qué ejecuta | Lo usan |
|---|---|---|---|
| `database` | Conexión Postgres directa, vía *pooler* | `SELECT 1` | 90 puntos del código |
| `supabase` | API REST sobre HTTP (PostgREST) | Lee una fila de `profiles` | 188 puntos del código |

Renombrar así, dejando claro en ambas que el proveedor es Supabase:

```diff
- Base de datos    →  + Supabase · Conexión directa
- Supabase         →  + Supabase · API de datos
```

Si el título queda largo para la tarjeta, la alternativa es dejar el nombre descriptivo
arriba y mover el proveedor a la línea de estado, que hoy solo dice «Conectado»:

```
[icono]  Conexión directa            [icono]  API de datos
         Supabase · Conectado ✓               Supabase · Conectado ✓
```

Lo importante es que **ninguna de las dos aparezca sin la palabra Supabase**: hoy solo una
la lleva, y eso es lo que hace pensar que son sistemas distintos.

**No son redundantes**: pueden fallar por separado, y cada fallo rompe cosas distintas.

- Si cae la **conexión directa**: dejan de funcionar las migraciones, el panel de
  administración y los registros de auditoría. El resto de la app sigue.
- Si cae la **API de datos**: se rompe casi todo — viajes, perfiles, notificaciones. Es el
  camino que usan dos de cada tres consultas.

Ambas traen el mismo tooltip que las integraciones externas, y su primera fila dice
`Proveedor: Supabase` — de modo que al pasar el cursor queda claro que son el mismo sitio
por dos caminos:

```
┌──────────────────────────────────────────────┐   ┌──────────────────────────────────┐
│ Conexión directa activa                      │   │ API de datos activa              │
│ SELECT 1 · conexión Postgres directa · 42 ms │   │ GET /rest/v1/profiles · 88 ms    │
│                                              │   │                                  │
│ Proveedor    Supabase                        │   │ Proveedor    Supabase            │
│ Acceso       Conexión Postgres (pooler)      │   │ Acceso       API REST (PostgREST)│
│ Servidor     db.rvlafaebvlrtrfdtcbut…        │   │ Proyecto     rvlafaebvlrtrfdtcbut│
│ Motor        PostgreSQL 17.6                 │   │ Consulta     profiles · 1 fila   │
│ Conexiones   1 abiertas · 1 libres           │   │ Respuesta    88 ms               │
│ En cola      0                               │   └──────────────────────────────────┘
│ Respuesta    42 ms                           │
└──────────────────────────────────────────────┘
```

### Email — mover a «Integraciones externas»

Hoy la tarjeta está arriba, junto a las comprobaciones locales, porque el backend solo
informaba **qué proveedor** estaba activo (`"sendgrid"`). Ya no: `email` se verifica de
verdad contra el proveedor, igual que Stripe o Twilio, y devuelve `connected` con su
detalle.

Moverla al bloque de integraciones externas y leerla de `integrations.email`.

### Infobip — eliminar la tarjeta

La integración no existía. El campo ya no se envía; en su lugar viene `twilio`, que es el
proveedor real y **sí se verifica**: el backend comprueba que la cuenta esté activa y que
el número de `TWILIO_PHONE_NUMBER` le pertenezca y tenga SMS habilitado.

---

## Valores de `apiStatus`

| Valor | Color sugerido | Significado |
|---|---|---|
| `connected` | Verde | Comprobación real que respondió bien. |
| `disconnected` | Rojo | Está configurado pero la comprobación falló. Es un fallo activo. |
| `not_configured` | Gris | Sin credencial. No es un error: puede ser intencional. |

### Qué se verifica y cuándo

| Integración | Cuándo | Por qué |
|---|---|---|
| `database` · `supabase` · `redis` | En cada llamada | Son gratis y locales. Traen `verifiedAt`, pero siempre es el instante de la consulta: **no tiene sentido mostrar «hace X»** en estas tarjetas. |
| `stripe` · `google_maps` · `firebase` · `twilio` · `email` | Al arrancar el servidor | Requieren red. Una llamada a Google Maps se factura: verificarla en cada consulta costaría ~$864 al mes solo por el panel. |

Ninguna integración devuelve ya `configured`: o se verifica de verdad, o no está configurada.

### Qué comprueba exactamente cada una

| Integración | Llamada | Qué detecta que la sola credencial no detectaría |
|---|---|---|
| `stripe` | `GET /v1/account` | **`charges_enabled`**: una cuenta con credenciales válidas que **no puede cobrar** — por verificación pendiente o suspensión parcial. Devolvería `disconnected` con ese motivo. |
| `google_maps` | `GET /maps/api/geocode/json` | Clave revocada, sin la API habilitada o con restricciones que la bloquean. Solo se prueba Geocoding: Directions y Places comparten la clave. |
| `firebase` | `POST /token` con JWT firmado | Una clave con formato válido que Google **rechaza**. Es exactamente el fallo que estuvo activo durante días. |
| `twilio` | `GET /Accounts` + `/IncomingPhoneNumbers` | Cuenta **Trial** (solo envía a números verificados), y que el número de `TWILIO_PHONE_NUMBER` **pertenezca a la cuenta** y tenga SMS habilitado. |
| `email` | Según el proveedor activo:<br>SendGrid `GET /v3/scopes`<br>Resend `GET /domains`<br>SMTP `verify()` | Una clave válida **sin permiso `mail.send`** — autentica bien y no puede enviar. En SMTP, abre la conexión y autentica sin mandar nada. |
| `database` | `SELECT 1` por el pool | **Consultas en cola**: el pool está limitado a 5 conexiones. Si `En cola` sube de 0, hay peticiones esperando y el resumen lo dice. |
| `supabase` | `GET /rest/v1/profiles` | Clave de servicio revocada o PostgREST caído, con el camino directo intacto. |
| `redis` | Estado del adaptador de Socket.IO | Que `REDIS_URL` esté puesta pero el adaptador **no haya conectado** — el sistema seguiría usando memoria sin avisar. |

---

## Mostrar el detalle de la verificación

### Formatear el tiempo relativo

```ts
function hace(iso: string | null): string {
  if (!iso) return 'sin verificar';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1)  return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24)   return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}
```

### Mapa de estados

```ts
const VISUAL = {
  connected:      { tono: 'verde', etiqueta: 'Conectado' },
  disconnected:   { tono: 'rojo',  etiqueta: 'Error' },
  // Ya no lo devuelve ninguna integración; se deja por si vuelve a aparecer.
  configured:     { tono: 'ambar', etiqueta: 'Configurado · sin verificar' },
  not_configured: { tono: 'gris',  etiqueta: 'Sin configurar' },
};
```

### La tarjeta con detalle al pasar el cursor

Los datos vienen de `integrations[nombre]`. `details` ya llega listo para
renderizar como filas: no hace falta lógica por integración.

```tsx
function TarjetaIntegracion({ nombre, icono, info }) {
  // info = data.integrations.stripe, por ejemplo
  const v = VISUAL[info.status] ?? VISUAL.not_configured;

  return (
    <Tooltip contenido={<DetalleVerificacion info={info} />}>
      <Tarjeta tono={v.tono}>
        {icono}
        <div>
          <strong>{nombre}</strong>
          <span className="sub">
            {info.summary ?? v.etiqueta}
            {info.verifiedAt && ` · ${hace(info.verifiedAt)}`}
          </span>
        </div>
      </Tarjeta>
    </Tooltip>
  );
}

function DetalleVerificacion({ info }) {
  return (
    <div className="detalle">
      <p className="detalle-titulo">{info.summary}</p>

      {/* Cómo se verificó */}
      {info.probe && (
        <p className="detalle-probe">
          <code>{info.probe}</code>
          {info.latencyMs != null && ` · ${info.latencyMs} ms`}
        </p>
      )}

      {/* Los campos validados */}
      <dl>
        {(info.details ?? []).map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <p className="detalle-pie">
        Verificado al iniciar el servidor · {hace(info.verifiedAt)}
      </p>
    </div>
  );
}
```

### Cómo se ve el tooltip

```
┌─────────────────────────────────────────────────┐
│ Cobros habilitados · producción                 │
│ GET https://api.stripe.com/v1/account · 663 ms  │
│                                                 │
│ Cuenta                 Urbont technology inc    │
│ ID                     acct_1TCplCQUi64j4EEw    │
│ Modo                   Producción (live)        │
│ País                   US                       │
│ Moneda                 USD                      │
│ Cobros habilitados     Sí                       │
│ Pagos habilitados      Sí                       │
│ Respuesta              HTTP 200 · 663 ms        │
│                                                 │
│ Verificado al iniciar el servidor · hace 4 h    │
└─────────────────────────────────────────────────┘
```

Cuando algo falla, el mismo tooltip muestra el motivo real. Con la credencial de
Firebase que estuvo rota:

```
┌─────────────────────────────────────────────────┐
│ invalid_grant: Invalid JWT Signature.           │
│ POST https://oauth2.googleapis.com/token        │
│                                                 │
│ Proyecto               urbonttech-e182d         │
│ Cuenta de servicio     firebase-adminsdk-…      │
│ ID de clave            c320c44fd999…            │
│ Respuesta              HTTP 400 · 210 ms        │
│ Error                  invalid_grant            │
│ Detalle                Invalid JWT Signature.   │
└─────────────────────────────────────────────────┘
```

Eso es lo que costó días descubrir a mano. Ahora está a un cursor de distancia.

### Sobre el sello de tiempo

Solo tiene sentido en las **cinco integraciones externas**. Las tres locales
(`database`, `supabase`, `redis`) también traen `verifiedAt`, pero es el instante de la
consulta: mostrar «hace 0 min» en cada refresco solo agrega ruido.

Para esas cinco, el timestamp es el del **arranque**, no de una revisión periódica. Si el servidor lleva
tres días encendido dirá «hace 3 d», y eso está bien: funcionaba al iniciar y nada se ha
reiniciado desde entonces. Pero visualmente puede leerse como dato viejo.

Dos formas de resolverlo:

- Redactarlo distinto: **«verificado al iniciar · hace 3 d»** deja claro que no es una
  revisión pendiente.
- Reverificar cada pocas horas. Sale casi gratis: cada 6 h son 120 llamadas al mes, unos
  **$0,60** en Google Maps. Requiere un cambio en el backend.

---

## Compatibilidad

`memory.rss`, `memory.heapUsed` y `memory.heapTotal` siguen presentes con los mismos
nombres. El panel actual sigue funcionando sin cambios — solo sigue mostrando el
porcentaje equivocado hasta que se apliquen los ajustes de arriba.

**Sí cambia:** el campo `apiStatus.infobip` ya no se envía. Si el panel lo lee, mostrará
vacío hasta que se cambie por `apiStatus.twilio`.

---

## Probar

```bash
curl -s https://api.urbont.com/api/admin/system \
  -H "Authorization: Bearer <TOKEN>" | jq
```

Valores esperados hoy, con el contenedor de 0,5 vCPU y 1 GB:

| Campo | Esperado |
|---|---|
| `memory.percent` | ≈ 6 |
| `memory.limitMb` | 1024 |
| `cpu.percent` | ≈ 2 |
| `cpu.vcpu` | 0.5 |
| `apiStatus.stripe` | `connected` · resumen «Cobros habilitados · producción» |
| `apiStatus.google_maps` | `connected` · resumen «Geocoding responde correctamente» |
| `apiStatus.firebase` | `not_configured` |
| `apiStatus.redis` | `not_configured` |
| `apiStatus.email` | `connected` · resumen «SendGrid · envía desde info@…» |
| `apiStatus.twilio` | `connected` · resumen «Cuenta activa · +1786…» |
| `apiStatus.database` | `connected` · resumen «Conexión directa activa» |
| `apiStatus.supabase` | `connected` · resumen «API de datos activa» |
| `integrations` | **8 claves**, todas con la misma forma |
| `integrations.stripe.details` | 8 filas, incluida «Cobros habilitados: Sí» |
| `integrations.database.details` | 7 filas, incluida «En cola: 0» |

**Diagnóstico rápido:** si `memory.limitMb` viniera muy alto (8192 o más), el servidor no
está leyendo los límites del contenedor y cayó al respaldo del host. En producción sobre
ECS debe dar `1024`.

---

*Documento interno · actualizado el 7 de septiembre de 2026*
