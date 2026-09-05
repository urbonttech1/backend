# urbont-api

Backend de URBONT: API REST y WebSocket. Es el único punto de contacto entre los
otros tres repos (`urbont-app`, `urbont-admin`, `urbont-web`) y la base de datos.

## Stack

Express 4 · Socket.IO · Supabase / PostgreSQL · Stripe · Firebase Admin (FCM) ·
Twilio · Resend · node-cron · Redis (opcional) · Pino · Sentry

## Estructura

```
server.ts              Arranque, CORS, rate limiting, montaje de routers
server/api/            28 routers (rides, drivers, admin, auth, corporate, ...)
server/services/       socketService, stateMachine, fcm, twilio, rideReassignment
server/db/             Cliente Supabase, pool de PG, migraciones, schemaCheck
server/jobs/           Tareas programadas (cron)
server/middleware/     Sanitización de bodies y auth
supabase_schema.sql    Esquema base
```

## Puesta en marcha

```bash
pnpm install
cp .env.example .env    # completar las variables
pnpm dev                # http://localhost:5000
```

Para crear la primera cuenta de admin:

```bash
DATABASE_URL=... ADMIN_EMAIL=admin@urbont.com ADMIN_PASSWORD=... \
  node scripts/create-admin-user.mjs
```

## Scripts

| Comando | Qué hace |
|---|---|
| `pnpm dev` | `tsx watch server.ts` |
| `pnpm build` | Bundle con esbuild a `dist/server.js` |
| `pnpm start` | `node dist/server.js` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Tests de vitest (`server/**/*.test.ts`) |

## CORS

`ALLOWED_ORIGIN` pasó de recomendada a **obligatoria** con la separación en repos.
Antes este server también servía el `dist/` del frontend, así que todo era mismo
origen. Ahora la app, el panel y el sitio llegan desde orígenes distintos.

Es una lista separada por comas y tiene que incluir el esquema de la APK:

```
ALLOWED_ORIGIN=https://app.urbont.com,https://admin.urbont.com,https://urbont.com,capacitor://localhost
```

Sin ella, en producción el server usa una allowlist hardcodeada y deja un warning
en el log.

## Deploy

`Dockerfile` multi-stage → Google Cloud Run. También hay `ecosystem.config.cjs`
para PM2 en modo cluster; Socket.IO necesita sesiones sticky, y con más de una
instancia hace falta `REDIS_URL` para el adapter.



admin@urbont.mx
admin123




aws ecr get-login-password --region us-east-1 --profile urbont | docker login --username AWS --password-stdin 083414536603.dkr.ecr.us-east-1.amazonaws.com



docker build -t 083414536603.dkr.ecr.us-east-1.amazonaws.com/urbont-api:latest .


docker push 083414536603.dkr.ecr.us-east-1.amazonaws.com/urbont-api:latest