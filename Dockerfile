# Run with `docker compose up --build`.
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ponytail: ships the whole build tree; switch to Next's `output: "standalone"` if image size matters.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data LIBRARY_DIR=/library
COPY --from=build /app ./
VOLUME ["/data", "/library"]
EXPOSE 3000
# The slim image has no curl or wget, so the check is done with Node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
