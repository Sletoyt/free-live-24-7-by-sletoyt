FROM node:20-alpine

RUN apk add --no-cache \
    ffmpeg \
    fontconfig \
    ttf-dejavu \
    openssh-client \
    bash \
    ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data assets media uploads

EXPOSE 3000 1935 8000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
