FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++
# pnpm 11 como en local. Con pnpm 9 el pnpm-workspace.yaml falla: esa version
# lo lee como definicion de workspace y exige un campo `packages`, mientras que
# aqui solo declara `allowBuilds`, que es sintaxis de pnpm 10+.
RUN npm install -g pnpm@11

# pnpm-workspace.yaml va antes del install: su `allowBuilds` es lo que autoriza
# el script de instalacion de esbuild, que pnpm 10+ bloquea por defecto.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile

COPY . .

# Solo API: no hay build de Vite ni variables VITE_*. Todo lo que necesita el
# server se lee de variables de entorno en runtime.
RUN pnpm run build

FROM node:22-alpine AS production

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@11 \
 && pnpm install --no-frozen-lockfile --prod --ignore-scripts \
 && pnpm store prune

COPY --from=builder /app/dist ./dist

# server.ts hace `import "dotenv/config"`, que lee ./.env desde el WORKDIR.
# Va al final a proposito: cambiar un secreto no invalida la cache de la capa
# de dependencias, que es la cara de reconstruir.
#
# ATENCION: los secretos quedan dentro de la imagen, en una capa inmutable.
# Borrarlos en una capa posterior NO los elimina (siguen en el historial).
# El repositorio de ECR debe permanecer privado.
COPY .env ./.env

# Se declaran despues del .env para que ganen sobre el archivo: dotenv no
# sobrescribe variables que ya existen en el entorno. El .env de desarrollo
# trae PORT=5000 y aqui hace falta 8080.
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/server.js"]
