FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache openssl && \
    npm ci --omit=dev

# ---

FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl && \
    addgroup -g 1001 -S nodeapp && \
    adduser -S nodeapp -u 1001 -G nodeapp && \
    mkdir -p /app/certs && chown nodeapp:nodeapp /app/certs

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER nodeapp

EXPOSE 4000

CMD ["node", "src/index.js"]
