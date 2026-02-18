# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache openssl

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---

FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl su-exec && \
    addgroup -g 1001 -S nodeapp && \
    adduser -S nodeapp -u 1001 -G nodeapp

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN chmod +x /app/entrypoint.sh

EXPOSE 4000

ENTRYPOINT ["/app/entrypoint.sh"]
