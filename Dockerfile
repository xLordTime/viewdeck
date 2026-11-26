FROM node:22-bookworm-slim
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY server.mjs worker.mjs page.mjs ./
RUN npm install --ignore-scripts --no-audit --no-fund --prefix /tmp/viewdeck-viewer @meshesha/pptxjs@2.0.0-alpha.0 && cp /tmp/viewdeck-viewer/node_modules/@meshesha/pptxjs/dist/pptxjs.umd.js /app/pptxjs.umd.js && rm -rf /tmp/viewdeck-viewer
USER node
CMD ["node","server.mjs"]
