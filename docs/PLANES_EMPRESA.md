# Planes para empresas

Plan de implementación de **Urbont for Business**: una empresa contrata un plan y
sus asociados reciben un descuento en cada viaje. Todo se ve y se gestiona desde el
panel admin.

---

## La conclusión primero

**Hoy ningún descuento llega al cobro.** Ni el de URBONT Pass, ni el de los códigos
promocionales, ni el corporativo. Los tres calculan o prometen una rebaja, y los
tres cobran el precio completo.

Construir los planes de empresa encima de eso sería el **cuarto** sistema que
promete un descuento y no lo aplica. Por eso este plan empieza por un bloque que
nadie pidió: un único motor de descuentos, dentro del servidor, que después usan
los planes de empresa, Pass y los códigos promocionales.

Y hay una decisión de negocio que bloquea todo lo demás: **quién paga el
descuento**. Con la comisión actual, la respuesta obvia deja a Urbont perdiendo
dinero con cualquier empresa que haga más de unos 14 viajes al mes. Está explicada
abajo.

---

## Lo que se pidió

| Plan | Cuota | Descuento | Asientos | Quién lo configura |
|---|---|---|---|---|
| Business | $49/mes | 10% para todos los asociados | hasta 100 | catálogo, desde el panel |
| Enterprise | a medida | a medida | ilimitados | **por empresa**, desde el panel |
| Team | $0 | *sin definir* | hasta 10 | aparece en la app, no se especificó |

Todo visible y gestionable desde el panel admin.

---

## Lo que hay hoy

Verificado contra el código y contra la base de producción el 2026-09-14.

| Pieza | Estado real |
|---|---|
| Tablas `corporate_accounts` y `corporate_members` | Existen. **0 filas.** |
| `/api/corporate` | Montado. Crea la cuenta y un cliente de Stripe, invita miembros por email, los quita, lista viajes. |
| `rides.corporate_acct_id` | Existe. **Nadie la escribe.** El historial y el gasto corporativo darían siempre vacío y $0. |
| `monthly_limit`, `current_month_spend` | Se guardan. Ningún código los compara ni los actualiza. |
| URBONT Pass | Cobra $29 prometiendo «10% off every ride». La tarifa **nunca consulta** la suscripción. 0 compradores. |
| Códigos promocionales | `/api/promo/validate` calcula el descuento y se lo devuelve a la app. La tarifa **nunca lo aplica**: `promo_discount` vale `0` en los 67 viajes que lo tienen. |
| Panel admin | Sin pantalla de empresas. Sin pantalla de códigos promocionales, aunque las rutas de admin existen. |
| `rides.payment_method` | Sólo admite `card` o `cash`. |
| Comisión | 10% del **total** cobrado para Urbont, 90% para el conductor (`services/rideMetrics.ts`). |

La pantalla de la app muestra además **«Trusted by 500+ companies»** con cero
empresas registradas. No es un fallo técnico, pero es una afirmación comercial
falsa ante clientes reales, y conviene retirarla ya, independientemente de este
plan.

---

## Por qué ningún descuento llega al cobro

La causa es la misma en los tres casos, y es la regla de diseño de todo el plan.

`POST /api/rides` recalcula el precio en el servidor a partir de la distancia y la
duración, y **sobrescribe** el `fare` que manda la app (`rides/create.ts:429`):

```
if (fareBreakdown && total > 0) {
  basePayload.fare = serverFare;           ← pisa lo que mandó el cliente
  extendedPayload.locked_fare = serverFare;
}
```

Esa guarda es correcta: impide que un cliente manipulado reserve con `fare: 0.01`.
Pero tiene una consecuencia: si la app aplica un descuento por su cuenta y manda un
precio rebajado, **el servidor lo borra y cobra el precio completo**. El equipo
móvil confirmó que siempre manda distancia y duración, así que la guarda actúa en
todos los viajes.

**Regla:** un descuento sólo existe si se calcula dentro del servidor, en el mismo
sitio donde se calcula el precio. Cualquier otro diseño vuelve a fallar en silencio.

---

## Decisión 1 · Quién paga el descuento — bloqueante

Hoy, en un viaje de $110:

```
pasajero paga   $110
conductor cobra  $99   (90%)
Urbont se queda  $11   (10%)
```

Con un 10% de descuento hay dos formas de repartirlo, y **no hay una tercera**:
el 10% de descuento sobre el total es exactamente la comisión entera de Urbont.

### A · Lo absorbe Urbont

```
pasajero paga    $99
conductor cobra  $99   (no cambia)
Urbont se queda   $0
```

El conductor no nota nada. Pero Urbont **no gana nada** con los viajes de esa
empresa: la cuota de $49 es el único ingreso.

Con el viaje medio real de Urbont —unos **$34**, calculado sobre los 10 viajes
completados que hay en la base— el margen por viaje es de unos $3,40. **$49
cubren unos 14 viajes al mes para toda la empresa.** Una empresa de 100 asientos
que haga 15 viajes mensuales ya le cuesta dinero a Urbont.

En Enterprise es peor: un descuento configurado por encima del 10% haría que
Urbont **pague de su bolsillo** la diferencia en cada viaje.

### B · Se reparte en proporción

```
pasajero paga    $99
conductor cobra  $89,10
Urbont se queda   $9,90
```

Urbont casi no pierde margen y la cuota es ingreso limpio. Pero **el conductor
subvenciona un plan que no firmó**: pierde un 10% en cada viaje corporativo, sin
elegirlo y probablemente sin saberlo.

### Lo que hace el código si no se decide nada

**B.** `calculateRideMetrics()` reparte el 10% y el 90% sobre lo que se cobre. Si se
aplica el descuento al total y no se toca nada más, los conductores pagan el
descuento automáticamente. Implementar A exige cambiar el reparto para que el
conductor cobre el 90% del precio **sin** descuento.

Es decir: no decidir es decidir B. Por eso esto va antes que cualquier línea de
código.

### Recomendación

A, con dos condiciones: el panel **impide** configurar en Enterprise un descuento
mayor que la comisión, y muestra por empresa cuánto le cuesta cada mes a Urbont.
Cargarle el descuento a conductores que no lo pactaron es peor para la retención y
más difícil de defender. Pero entonces el precio de $49 hay que justificarlo por
volumen o asumirlo como coste de captación — y esa es una decisión de negocio, no
técnica.

---

## Otras decisiones, no bloqueantes

| Pregunta | Recomendación |
|---|---|
| ¿Se acumulan descuentos? (Business + Pass + código) | **No.** Se aplica el mayor. Acumular abre combinaciones que dejan precios negativos. |
| ¿Qué incluye el plan Team? | Sin descuento: gestión de equipo e historial. Si llevara descuento con cuota $0, sería un cupón gratuito del 10% para cualquiera que cree una empresa. |
| ¿Qué pasa si la empresa no paga? | El descuento sigue 7 días en `past_due` y se corta al cancelarse. Los viajes ya creados conservan el suyo. |
| ¿Cómo paga Enterprise? | Por factura de Stripe (`collection_method: 'send_invoice'`), no con tarjeta. Es como pagan las empresas grandes. |
| ¿El descuento vale para viajes personales del empleado? | Sí. El pedido fue «todos los asociados tienen 10%», y el modelo es descuento, no viaje pagado por la empresa. |

---

## Tres problemas que hay que arreglar antes

### 1 · `/api/subscriptions/activate` activa Pass gratis

La verificación de pago está dentro de `if (paymentIntentId)`. Si la petición llega
**sin** ese campo, se salta la verificación y activa Pass igual
(`subscriptions.ts:188`).

Hoy es inofensivo porque nadie lee el Pass. **El día que el motor de descuentos lo
lea, cualquiera obtiene un 10% en todos sus viajes con una petición vacía.** Se
arregla antes de conectar Pass al motor, sin excepción.

### 2 · Pass no es una suscripción

Sin `URBONT_PASS_PRICE_ID` configurado —y no lo está—, la compra hace un cobro
único de $29 y nunca se renueva. Y como no hay suscripción de Stripe, el webhook de
cancelación no se dispara nunca: **un Pass comprado así duraría para siempre**. La
Business no puede repetir ese atajo.

### 3 · `/api/promo/redeem` confía en el cliente

Registra el `discountApplied` que manda la app, sin recalcularlo. Cuando el motor
aplique los códigos promocionales, el descuento lo decide el servidor y este
endpoint pasa a sólo registrar lo que el servidor ya calculó.

---

## Diseño

### Un solo motor de descuentos

`server/services/discounts.ts`, con una función:

```ts
resolveDiscount(userId, opts?: { promoCodeId?: string })
  → { pct: number; source: 'enterprise' | 'business' | 'pass' | 'promo' | null;
      corporateAccountId: string | null }
```

La llaman exactamente los mismos sitios que calculan un precio:
`GET /calculate-fare` (tarifa por distancia y por hora), `GET /estimate`, y la
guarda de `POST /api/rides`. **Nada más calcula descuentos.**

Mismo esqueleto que `fareConfig.ts` y `serviceZones.ts`: se resuelve en memoria con
caché corta e invalidación al guardar desde el panel. `calculate-fare` corre tres
veces por cotización —una por clase de vehículo—, y consultar la base en cada una
sería caro sin necesidad.

### El descuento se congela en el viaje

Como `locked_fare` y `zone_id`: el pasajero aceptó un precio con un descuento, y que
la empresa cancele el plan a mitad de trayecto no debe cambiarlo.

```sql
ALTER TABLE rides ADD COLUMN discount_pct     NUMERIC(5,2)  DEFAULT 0;
ALTER TABLE rides ADD COLUMN discount_amount  NUMERIC(10,2) DEFAULT 0;
ALTER TABLE rides ADD COLUMN discount_source  TEXT;
-- rides.corporate_acct_id ya existe: por fin se escribe.
```

### El reparto con el conductor

Si la decisión 1 es A, `calculateRideMetrics()` recibe dos importes —el cobrado y el
de antes del descuento— y calcula el pago al conductor sobre el segundo. Si es B,
no cambia. En ambos casos queda escrito y probado: hoy el reparto es implícito, y
aquí es donde un descuento mal conectado le quita dinero a alguien sin que nadie lo
note.

### Modelo de datos

**Catálogo de planes**, nuevo, editable desde el panel. Evita repetir lo que pasó
con las tarifas: $49 y 10% escritos en el código.

```sql
CREATE TABLE corporate_plans (
  id              TEXT PRIMARY KEY,         -- 'team' | 'business' | 'enterprise'
  name            TEXT NOT NULL,
  monthly_fee     NUMERIC(10,2) NOT NULL,
  discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  seat_limit      INTEGER,                  -- NULL = ilimitado
  stripe_price_id TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

**`corporate_accounts`**, se amplía. Enterprise guarda aquí su cuota y su descuento
propios, que prevalecen sobre el catálogo.

```sql
ALTER TABLE corporate_accounts ADD COLUMN plan                   TEXT;
ALTER TABLE corporate_accounts ADD COLUMN status                 TEXT DEFAULT 'pending';
ALTER TABLE corporate_accounts ADD COLUMN discount_pct_override  NUMERIC(5,2);
ALTER TABLE corporate_accounts ADD COLUMN monthly_fee_override   NUMERIC(10,2);
ALTER TABLE corporate_accounts ADD COLUMN seat_limit_override    INTEGER;
ALTER TABLE corporate_accounts ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE corporate_accounts ADD COLUMN current_period_end     TIMESTAMPTZ;
```

`monthly_limit` y `current_month_spend` se quedan sin usar: eran de un modelo donde
la empresa pagaba los viajes, y ese no es el que se pidió. No se borran, se anotan.

### Cobro de la cuota

- **Business:** suscripción real de Stripe sobre el cliente de la empresa, que
  `/api/corporate` ya crea. Con un `stripe_price_id` configurado de verdad.
- **Enterprise:** al fijar la cuota en el panel, el backend crea un precio de
  Stripe para ese importe. Los precios de Stripe no se editan: cambiar la cuota es
  crear uno nuevo y actualizar la suscripción.
- **Webhooks:** hoy `customer.subscription.deleted` e `invoice.payment_failed` sólo
  entienden `metadata.user_id`, que es el caso de Pass. Se amplían para reconocer
  `metadata.corporate_account_id`, y se añaden `invoice.paid` y
  `customer.subscription.updated` para mantener `status` y `current_period_end`.

### Asientos

`POST /api/corporate/invite` rechaza al superar el límite del plan. Un asiento es
una cuenta de Urbont, no una persona. Quitar a un miembro ya lo desactiva y le borra
el vínculo; eso se conserva, y el descuento se le corta en la siguiente cotización.

---

## Panel admin · pantalla «Empresas»

Roles `owner` y `operations`, como Tarifas. Toda modificación va a `audit_logs`,
como las zonas.

**Lista.** Empresa, plan, estado —activa, pendiente, impago, cancelada—, asientos
usados sobre el límite, descuento, cuota, y dos cifras que hoy no existen en ningún
sitio: **descuento concedido este mes** y **coste real para Urbont**. La segunda es
la que dice si un plan pierde dinero, y es la respuesta a la decisión 1 en números.

**Ficha de empresa.** Cambiar de plan. En Enterprise, cuota y descuento editables.
Miembros con alta y baja. Historial de viajes con su descuento. Estado de la
suscripción en Stripe.

**Catálogo de planes.** Cuota, descuento y asientos de Team y Business.

**Guardas.**
- Un descuento de Enterprise mayor que la comisión no se guarda, y el aviso muestra
  la pérdida por viaje en dólares, no en porcentaje.
- Cambiar el precio del catálogo **no** cambia las suscripciones existentes —así
  funciona Stripe—, y la pantalla lo dice antes de guardar.
- Una empresa no se borra si tiene viajes con descuento: se cancela.

---

## Contrato con la app móvil

**Campos nuevos en respuestas existentes**, que según su propia regla no rompen
nada:

| Endpoint | Campos |
|---|---|
| `GET /calculate-fare`, `GET /estimate` | `discount_pct`, `discount_amount`, `discount_source`, `total_before_discount` |
| `GET /api/rides/:id` | los mismos, congelados en el viaje |
| `GET /api/corporate/me` | `plan`, `status`, `discount_pct`, `seats_used`, `seat_limit` |

`total` pasa a ser el importe **con** descuento. Es un cambio de valor, no de forma,
y es el correcto: un APK viejo que pinte `total` mostrará lo que de verdad se cobra.

**Lo que tiene que hacer la app:**
1. Dejar de calcular descuentos por su cuenta: Pass y códigos promocionales. El
   servidor los borraría igual.
2. Conectar «Get started» a un endpoint nuevo de contratación de Business.
3. Retirar «Trusted by 500+ companies».

Esto se negocia con ellos en un handshake, igual que el de precios.

---

## Fases

El orden empieza por lo que no cambia ningún precio y termina por lo que obliga a
publicar una versión de la app.

**Fase 0 · Decisiones.** Quién paga el descuento, acumulación, contenido de Team,
gracia por impago, factura para Enterprise. Sin código.

**Fase 1 · Motor de descuentos.** `discounts.ts`, conexión en los tres puntos de
cálculo, columnas congeladas en el viaje, reparto con el conductor según la
decisión 1, y el arreglo de `/activate`. **Transparente**: con cero empresas y cero
Pass activos, ningún precio cambia.

**Fase 2 · Modelo corporativo.** Catálogo de planes, ampliación de
`corporate_accounts`, límite de asientos.

**Fase 3 · Panel «Empresas».** Lista, ficha, catálogo, guardas y auditoría.
Con esto se puede dar de alta una Enterprise a mano desde el panel, antes de que
exista la compra desde la app.

**Fase 4 · Stripe.** Suscripción Business, precios de Enterprise, webhooks.

**Fase 5 · App móvil.** Handshake, campos nuevos, contratación desde «Get started».

**Fase 6 · Reconectar Pass y códigos promocionales al motor.** Hoy están rotos;
con el motor hecho, arreglarlos es barato.

---

## Cómo se prueba

**Que no se rompió nada.** Sin empresas activas, las cotizaciones de referencia dan
exactamente lo mismo que hoy: Miami, Naples, tarifa por hora, y la guarda
rechazando `fare: 0.01`.

**Que el descuento llega al cobro**, que es justo lo que hoy falla:
1. Un miembro de una empresa Business cotiza y ve el 10%.
2. Reserva, y el viaje se crea **con ese mismo precio** — la guarda no lo borra.
3. Stripe cobra ese importe.
4. El pago al conductor es el que dicte la decisión 1, comprobado en
   `application_fee_amount`.

**Que se corta cuando debe.** La empresa cancela: la siguiente cotización va sin
descuento, y un viaje ya creado conserva el suyo.

**Las guardas.** La invitación número 11 en Team se rechaza. `/activate` sin
`paymentIntentId` se rechaza. Un descuento de Enterprise por encima de la comisión
no se guarda.

---

## Lo que este plan no hace

- **Viajes pagados por la empresa.** El diseño original de `corporate_accounts`, con
  su tope de gasto mensual, apuntaba ahí. No es lo que se pidió.
- **Descuento en viajes de valet.** `rides/valet.ts` calcula su propia comisión y
  quedaría fuera del motor. Se decide aparte.
- **Alta automática por dominio**, que todo `@empresa.com` entre solo. Útil, más
  adelante.
- **Impuestos.** El impuesto sobre ventas de una suscripción varía por estado en
  EE.UU. Hay que mirarlo antes de facturar la primera cuota.
