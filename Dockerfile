FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY config ./config
COPY server.js ./
COPY public ./public

ENV HOST=0.0.0.0 PORTA=3000 BASE_PATH=/notas-mei-ste
EXPOSE 3000

CMD ["node", "server.js"]
