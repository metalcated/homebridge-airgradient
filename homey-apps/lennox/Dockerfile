FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run lint && npm test && npm run validate && npm run build && npm run check:package
ENV HOMEY_HOME=/auth
CMD ["sh", "-c", "./node_modules/.bin/homey select && node scripts/install-app.cjs"]
