FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY VERSION .
# The app runs as the unprivileged "node" user, so it must own the data folder.
# A new named volume inherits this ownership on first mount.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 SPOOLRSS_DATA=/data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
