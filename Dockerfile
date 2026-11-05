# Sahabat Kreator — image build & runtime.
#
# Satu image "build" dipakai bersama oleh api/worker/realtime (perbedaan
# hanya perintah start), dan satu image nginx untuk web statis. Alasannya:
# ketiga proses berbagi seluruh paket workspace, dan tsup sudah membundel
# paket @sahabat-kreator/* ke dalam dist — memisahkannya hanya akan
# menduplikasi node_modules 3x tanpa manfaat.
#
# `pg` sengaja TIDAK dibundel (lihat apps/api/tsup.config.ts): harus ada
# tepat satu salinan di node_modules, karena drizzle memeriksa
# `instanceof Pool`. Karena itu node_modules ikut ke image runtime.

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# Seluruh konteks disalin sekali. Untuk repo sebesar ini, memecah layer
# per package.json menambah 20+ langkah COPY tanpa penghematan nyata —
# yang mahal adalah `pnpm install`, bukan COPY.
COPY . .
RUN pnpm install --frozen-lockfile

# Build aplikasi server (tsup → dist/index.js) dan web (vite → dist).
RUN pnpm --filter @sahabat-kreator/api build \
 && pnpm --filter @sahabat-kreator/worker build \
 && pnpm --filter @sahabat-kreator/realtime build \
 && pnpm --filter @sahabat-kreator/web build

FROM node:22-bookworm-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# Non-root: image ini menyimpan kredensial tenant terenkripsi di memori.
RUN chown -R node:node /app
USER node
CMD ["node", "apps/api/dist/index.js"]

FROM nginx:1.27-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
