# منصة الإدارة والأداء — صورة تشغيل واحدة تعمل مباشرة على Railway وRender وأي خادم Docker
FROM node:22-alpine
WORKDIR /app
COPY app/ ./
# قيم افتراضية لنسخة العرض. تُغيَّر من متغيرات البيئة في منصة الاستضافة دون تعديل الكود.
ENV NODE_ENV=production \
    TZ=Africa/Cairo \
    PORT=3000 \
    DEMO_MODE=1 \
    AUTO_SEED=1 \
    HTTPS=1 \
    TRUST_PROXY=1 \
    DB_PATH=/data/app.db \
    FILES_DIR=/data/files
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "--no-warnings", "server.js"]
