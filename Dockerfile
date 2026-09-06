FROM node:20-alpine

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create data directories
RUN mkdir -p data uploads/pending uploads/approved

EXPOSE 3000

CMD ["node", "server.js"]
