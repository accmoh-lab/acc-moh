FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 TZ=Africa/Cairo
RUN mkdir -p /var/lib/acc && chown node /var/lib/acc
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--no-warnings", "server.js"]
