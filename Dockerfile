FROM node:22-bookworm-slim
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY server.mjs worker.mjs page.mjs ./
USER node
CMD ["node","server.mjs"]
