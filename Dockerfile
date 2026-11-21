# The same `npm run build` / `npm start` this image runs has been checked without Docker;
# the image itself has not been built. Build with `docker compose up --build`.
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
CMD ["npm", "start"]
