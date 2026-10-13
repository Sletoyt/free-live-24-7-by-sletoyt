# Production-Optimized Dual-Stream Cloud Playout Container
FROM node:20-alpine

# Install FFmpeg, Fonts (for drawtext filters), bash and media utilities
RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    bash \
    ca-certificates

WORKDIR /app

# Cache dependency layer
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Ensure persistent directories exist (including Cloud File System uploads/)
RUN mkdir -p data assets media uploads

# Expose required ports:
# 3000 -> Cute Sky Web Dashboard, File System & Dual Studio
# 1935 -> RTMP Ingest from Local PC OBS (Window + Voiceover)
# 8000 -> HTTP-FLV & HLS Playout Preview Stream
EXPOSE 3000 1935 8000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
