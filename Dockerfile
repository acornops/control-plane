FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS dev
WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

EXPOSE 8081
CMD ["npm", "run", "dev"]

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY .env.example ./.env.example
RUN chown -R node:node /app
USER node

EXPOSE 8081
CMD ["node", "dist/server.js"]
