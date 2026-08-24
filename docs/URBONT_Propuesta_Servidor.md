# URBONT — Infraestructura y Servicios Técnicos
### Propuesta de Mantenimiento Anual · Confidencial

---

## Resumen Ejecutivo

URBONT es una plataforma de movilidad premium en tiempo real. Su funcionamiento estable, seguro y continuo depende de una arquitectura distribuida que integra múltiples servicios especializados. Este documento detalla cada componente de infraestructura, su propósito técnico, y el costo real de mercado asociado.

El precio de mantenimiento anual de **$4,000 USD** cubre la totalidad de los servicios descritos a continuación, más el soporte técnico humano dedicado a su operación.

---

## 1. Servidor de Producción

| Especificación | Detalle |
|---|---|
| **CPUs** | 4 vCPUs dedicados |
| **RAM** | 8 GB DDR5 |
| **Almacenamiento** | 160 GB NVMe SSD |
| **Transferencia de datos** | 5 TB/mes de ancho de banda |
| **Disponibilidad garantizada** | 99.9% uptime (SLA) |
| **Sistema operativo** | Linux Ubuntu 22.04 LTS |
| **Ubicación** | Datacenter East USA (menor latencia para Miami) |
| **Costo de mercado** | $65/mes · **$780/año** |

El servidor aloja el backend de URBONT: la API en tiempo real, el motor de WebSockets para GPS en vivo, el sistema de autenticación, y la lógica de negocio de viajes. Una caída del servidor significa que ningún viaje puede procesarse.

---

## 2. Base de Datos — Supabase Pro

| Especificación | Detalle |
|---|---|
| **Motor** | PostgreSQL 15 (managed) |
| **Almacenamiento** | 8 GB de base de datos |
| **Backups automáticos** | Diarios con retención de 7 días |
| **Point-in-Time Recovery** | Recuperación hasta el minuto exacto |
| **Alta disponibilidad** | Réplica en standby automática |
| **Autenticación integrada** | Sistema de login seguro con JWT |
| **Realtime** | Canal de eventos en vivo (GPS, chat, estados) |
| **Costo de mercado** | $25/mes · **$300/año** |

La base de datos almacena todos los viajes, perfiles de usuarios, conductores, pagos, mensajes de chat, documentos y logs del sistema. Su integridad y disponibilidad son críticas para la operación del negocio.

---

## 3. Protección y Rendimiento — CDN + DDoS

| Especificación | Detalle |
|---|---|
| **Servicio** | Cloudflare Pro |
| **Protección DDoS** | Mitigación automática de ataques |
| **Firewall de aplicación web (WAF)** | Reglas de seguridad activas |
| **CDN global** | Assets cargados desde el nodo más cercano al usuario |
| **Caché inteligente** | Reduce carga del servidor hasta 70% |
| **SSL/TLS automático** | Certificado HTTPS renovado automáticamente |
| **Costo de mercado** | $20/mes · **$240/año** |

Sin protección DDoS, un ataque de tráfico puede derribar la app en minutos. El CDN además acelera la carga del mapa y la interfaz para cada usuario.

---

## 4. Mapas y Navegación — Google Maps

| Especificación | Detalle |
|---|---|
| **Servicio** | Google Maps + Directions + Places API |
| **Uso** | Mapa 3D en tiempo real, rutas con tráfico, geocodificación |
| **Carga estimada** | 50,000 sesiones de mapa / mes |
| **Rutas calculadas** | Por cada viaje: cálculo de ruta, ETA y distancia real |
| **Costo de mercado** | $50/mes · **$600/año** |

Cada vez que un pasajero abre la app, el mapa carga. Cada viaje calcula una ruta. Este servicio es el componente visual más crítico de la experiencia del usuario.

---

## 5. Traducción en Tiempo Real — xAI (Grok)

| Especificación | Detalle |
|---|---|
| **Motor de IA** | Grok (xAI) — modelo de lenguaje avanzado |
| **Uso** | Traducción bidireccional conductor↔pasajero en el chat |
| **Idiomas** | Inglés, Español, Portugués, Francés |
| **Latencia** | < 1 segundo por traducción |
| **Costo de mercado** | $30/mes · **$360/año** |

El chat de URBONT traduce mensajes automáticamente entre conductor y pasajero en tiempo real. Sin este servicio, la comunicación entre hablantes de diferentes idiomas no es posible.

---

## 6. Notificaciones Push — Firebase (FCM)

| Especificación | Detalle |
|---|---|
| **Servicio** | Google Firebase Cloud Messaging |
| **Uso** | Alertas de viaje confirmado, conductor llegando, viaje completado |
| **Plataformas** | Android e iOS (nativos) + navegadores (PWA) |
| **Confiabilidad** | 99.95% tasa de entrega de notificaciones |
| **Costo de mercado** | $20/mes · **$240/año** |

Las notificaciones push informan al pasajero cuando su conductor acepta el viaje, cuando está llegando, y cuando el viaje termina. Sin este servicio, el usuario debe estar con la app abierta permanentemente.

---

## 7. Rastreo de Vuelos — AviationStack

| Especificación | Detalle |
|---|---|
| **Servicio** | AviationStack API |
| **Uso** | Verificación de vuelos en tiempo real para airport pickups |
| **Datos** | Estado del vuelo, hora real de llegada, terminal, puerta |
| **Cobertura** | Más de 10,000 aerolíneas globales |
| **Costo de mercado** | $15/mes · **$180/año** |

Para recogidas en el aeropuerto, la app verifica el vuelo del pasajero y ajusta el tiempo de llegada del conductor automáticamente si el vuelo llega tarde o adelantado.

---

## 8. Monitoreo de Errores — Sentry

| Especificación | Detalle |
|---|---|
| **Servicio** | Sentry Team |
| **Uso** | Detección automática de errores en frontend y backend |
| **Alertas** | Notificación inmediata ante cualquier fallo en producción |
| **Retención de datos** | 90 días de historial de errores |
| **Costo de mercado** | $26/mes · **$312/año** |

Sentry detecta y reporta cualquier error que experimente un usuario, antes de que el cliente o los usuarios lo reporten. Permite resolver problemas en minutos en lugar de días.

---

## 9. Mantenimiento Técnico y Soporte

| Servicio | Descripción |
|---|---|
| **Actualizaciones de seguridad** | Parches mensuales de dependencias y librerías |
| **Monitoreo 24/7** | Alertas automáticas ante caídas o anomalías |
| **Respuesta ante incidentes** | Tiempo de respuesta garantizado ante fallos |
| **Backups verificados** | Validación mensual de que los respaldos son restaurables |
| **Optimización de rendimiento** | Ajustes periódicos de base de datos e infraestructura |
| **Soporte técnico directo** | Canal de comunicación directa para consultas técnicas |
| **Costo de mercado** | $289/año (incluido en el paquete) |

---

## Resumen de Costos

| Componente | Costo anual de mercado |
|---|---|
| Servidor de producción (4 vCPU / 8 GB RAM) | $780 |
| Base de datos Supabase Pro + backups + realtime | $300 |
| CDN + DDoS + Firewall (Cloudflare Pro) | $240 |
| Mapas y rutas en tiempo real (Google Maps) | $600 |
| Traducción IA en tiempo real (xAI Grok) | $360 |
| Notificaciones push Android/iOS (Firebase) | $240 |
| Rastreo de vuelos en tiempo real (AviationStack) | $180 |
| Monitoreo de errores en producción (Sentry) | $312 |
| Mantenimiento, soporte y gestión técnica | $289 |
| **TOTAL** | **$3,301 en servicios + gestión incluida** |

---

## Precio del Paquete Anual

> ### $4,000 USD / año
> *Incluye la totalidad de los servicios descritos, gestión técnica, monitoreo activo y soporte directo.*
>
> Equivalente a **$333 USD/mes** — el costo de media jornada de un técnico de sistemas, por la operación completa de una plataforma de movilidad profesional.

---

## ¿Por Qué No Contratar Cada Servicio por Separado?

Contratar, configurar, integrar y mantener cada uno de estos servicios de forma independiente requiere conocimiento técnico especializado, tiempo de configuración inicial, y monitoreo constante. Delegar la gestión completa de la infraestructura garantiza:

- **Cero interrupciones** sin asistencia técnica inmediata
- **Seguridad** de los datos de clientes y conductores
- **Escalabilidad** cuando el volumen de viajes crezca
- **Un solo punto de contacto** para cualquier problema técnico

---

*Documento preparado por el equipo técnico de URBONT · Abril 2026*
*Precios de mercado verificables en: digitalocean.com · supabase.com · cloud.google.com/maps-platform · sentry.io · firebase.google.com*
