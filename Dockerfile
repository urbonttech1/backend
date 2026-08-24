FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++
RUN npm install -g pnpm@9

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile

COPY . .

# Solo API: no hay build de Vite ni variables VITE_*. Todo lo que necesita el
# server se lee de variables de entorno en runtime.
RUN pnpm run build

FROM node:22-alpine AS production

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@9 \
 && pnpm install --no-frozen-lockfile --prod --ignore-scripts \
 && pnpm store prune

COPY --from=builder /app/dist ./dist

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/server.js"]
