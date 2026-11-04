FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY . .
RUN bun run scripts/build-web.ts

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4180 DATA_DIR=/app/data DB_PATH=/app/data/sammlerwert.db RAW_DIR=/app/data/raw UPLOADS_DIR=/app/data/uploads WEB_DIR=/app/web/public
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web/public ./web/public
COPY --from=build /app/package.json ./
VOLUME ["/app/data"]
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:4180/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "server/index.ts"]
