# Build from the Cards repository root. Games deploy independently.
FROM node:22-alpine AS builder
WORKDIR /app
COPY public/ ./public/
COPY scripts/build.mjs ./scripts/build.mjs
RUN node scripts/build.mjs

FROM nginx:alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
ENV CARDS_DNS_RESOLVER=127.0.0.11 NGINX_ENVSUBST_FILTER=CARDS_DNS_RESOLVER
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY deploy/proxy.conf /etc/nginx/cards-proxy.conf
COPY deploy/api-proxy.conf /etc/nginx/cards-api-proxy.conf
COPY deploy/socket-proxy.conf /etc/nginx/cards-socket-proxy.conf
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
