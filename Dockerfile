# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- run ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8765 \
    DATA_DIR=/DATA/AppData/zimamc \
    STATIC_DIR=/app/frontend/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/frontend/dist ./frontend/dist
COPY package.json ./
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/api/status || exit 1
CMD ["node", "backend/dist/index.js"]
