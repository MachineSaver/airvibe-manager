FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./

RUN npm ci

# ---

FROM node:20-alpine AS builder

WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ---

FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup -g 1001 -S nextjs && \
    adduser -S nextjs -u 1001 -G nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static

USER nextjs

ENV HOSTNAME="0.0.0.0"

EXPOSE 3000

CMD ["node", "server.js"]
