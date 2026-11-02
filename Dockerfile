FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=10000
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY payment-client.js ./
COPY server.js config.js postgres-store.js payments.js privacy.js worker.js huggingface.js x402-payment.js ./
COPY public/ ./public/
RUN test -f public/index.html
RUN npm run build:payment-client && npm prune --omit=dev
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
