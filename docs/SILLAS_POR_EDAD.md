# Sillas por edad en una reserva

Es una opción al programar el viaje. Si el pasajero o el valet la piden, queda escrita en la reserva como requisito. El chofer la ve junto con la oferta y acepta solo si puede cumplirla. No se asigna un chofer a la fuerza ni se aparta la reserva para alguien en particular.

Solo se puede pedir en un viaje programado: el pasajero eligió fecha y hora, o el valet marcó Schedule. Un viaje para ahora, o uno por horas sin fecha, no muestra la opción y el servidor no la guarda.

Las edades son una guía para elegir el tipo. Nadie escribe la fecha de nacimiento. Se elige la silla y cuántas. Si no necesitan silla, no marcan nada y la reserva sale como hoy: la acepta el primer chofer que pueda hacer ese viaje.

No tiene costo extra. El texto libre de la nota (`rides.notes`) sigue aparte. La silla no se escribe ahí, porque el chofer y el panel tienen que ver cantidades.

El feature de empresas con choferes queda en espera. Esta opción no cambia quién recibe la reserva: sigue ofreciéndose a los choferes cercanos, y el primero que acepta se la queda.

## Las tres sillas

| Clave | Qué es | Para quién | Cómo va el niño |
|---|---|---|---|
| `rear_facing` | Silla mirando hacia atrás | Bebé, de 0 a 12 meses | Es la única forma segura a esta edad. Protege la cabeza y el cuello si hay un frenazo o un golpe. |
| `forward_facing` | Silla mirando hacia adelante, con arnés de 5 puntos | Niño pequeño, de 1 a 4 años | Mira al frente del auto y lo sujeta el arnés de la silla, no el cinturón del auto. |
| `booster` | Asiento elevador | De 4 a 12 años | Sube al niño para que el cinturón del auto, hecho para un adulto, le quede en la cadera y el hombro. |

## Qué se guarda

Una columna nueva en `rides`: `child_seats` (JSON). Null si no pidieron ninguna.

```json
{ "rear_facing": 1, "forward_facing": 0, "booster": 2 }
```

Cada número es un entero de 0 para arriba. La suma de las tres no pasa de 4. Si las tres están en 0, se guarda null.

## Cuándo se puede pedir

`POST /api/rides` y `POST /api/rides/valet-dispatch` aceptan `childSeats` solo si el viaje trae `scheduledAt` con más de 30 minutos de anticipación. Esa es la misma regla que hoy deja el viaje en estado `scheduled` y lo ofrece a los choferes para que uno lo acepte. Si el viaje es para ahora, o la hora queda a 30 minutos o menos, y aun así mandan sillas, la respuesta es `400 CHILD_SEATS_SCHEDULED_ONLY` y la reserva no se crea.

Un tipo distinto de esas tres claves, un número negativo o una suma mayor a 4 responde `400 CHILD_SEATS_INVALID`.

## Dónde se elige

En la app del pasajero, los tres contadores aparecen solo al elegir fecha y hora. Son opcionales. En un viaje para ahora o por horas no se muestran.

En el valet, los mismos contadores aparecen solo cuando Schedule está encendido.

Cada fila es el nombre de la silla, la edad y un menos y un más. Los textos de esas pantallas van en inglés, porque la app es para Estados Unidos: Child seats, Rear-facing, Forward-facing, Booster.

## Qué ve el chofer

La oferta de esa reserva muestra el requisito junto con la hora, el origen y el destino. Ejemplo: “Needs 1 rear-facing seat”. Si no pidieron sillas, la oferta no dice nada de esto.

El chofer que tiene esas sillas acepta. El que no las tiene no acepta. La app no comprueba si de verdad las tiene: el requisito está a la vista y aceptar es decir que puede cumplirlo.

## Qué pinta el panel

El panel no está en este repositorio. En el detalle de una reserva se leen las tres cantidades, o nada si `childSeats` es null. Es la descripción del requisito, no una tarea para asignar un chofer. Un viaje que no es reserva no lleva este campo.
