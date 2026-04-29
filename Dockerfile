FROM node:22-alpine
RUN apk add --no-cache bash
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
