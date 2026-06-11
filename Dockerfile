FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN bun build src/index.ts --compile --outfile server

FROM alpine:3.20 AS runner
WORKDIR /app

RUN apk add --no-cache ca-certificates libstdc++ libgcc

COPY --from=builder /app/server ./server

RUN mkdir -p audio-cache

ENV NODE_ENV=production

CMD ["./server"]
