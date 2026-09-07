FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Persistent data path (Fly.io volume mounts at /data)
ENV PERSISTENT_DATA_PATH=/data
RUN mkdir -p /data/uploads/pending /data/uploads/approved /data/data

EXPOSE 3000

CMD ["node", "server.js"]
