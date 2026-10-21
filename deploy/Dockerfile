# syntax=docker/dockerfile:1
# Build from the directory containing cards/, hearts/, and euchre/.
FROM node:22-alpine AS hearts
WORKDIR /app
COPY hearts/web/package.json hearts/web/package-lock.json hearts/web/.npmrc ./
RUN --mount=type=secret,id=fontawesome_token,env=FONTAWESOME_PACKAGE_TOKEN,required=true npm ci --no-audit --no-fund
COPY hearts/web/ ./
ENV VITE_BASE_PATH=/hearts/ VITE_SHARED_ACCOUNTS=true
RUN npm run build

FROM node:22-alpine AS euchre
WORKDIR /app
COPY euchre/web/package.json euchre/web/package-lock.json euchre/web/.npmrc ./
RUN --mount=type=secret,id=fontawesome_token,env=FONTAWESOME_PACKAGE_TOKEN,required=true npm ci --no-audit --no-fund
COPY euchre/web/ ./
ENV VITE_BASE_PATH=/euchre/ VITE_ACCOUNT_API_URL=/api/account
RUN npm run build

FROM nginx:alpine
COPY cards/public/ /usr/share/nginx/html/
COPY --from=hearts /app/dist/ /usr/share/nginx/html/hearts/
COPY --from=euchre /app/dist/ /usr/share/nginx/html/euchre/
COPY cards/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY cards/deploy/proxy.conf /etc/nginx/cards-proxy.conf
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
