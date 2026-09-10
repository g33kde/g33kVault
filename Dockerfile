# --- client build ---
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# --- server build ---
FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ ./
RUN npm run build

# --- runtime ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# System binary, not an npm dependency — used by videoConvert.ts to
# transcode guest-uploaded .mpg/.mpeg to MP4 (poor native <video> browser
# support otherwise). Same category as this image not needing a compiler
# toolchain for sharp/etc: a real package, not something node-gyp builds.
RUN apk add --no-cache ffmpeg
COPY server/package*.json ./
RUN npm install --omit=dev
COPY --from=server-build /app/server/dist ./dist
COPY --from=client-build /app/client/dist ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
