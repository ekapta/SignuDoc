FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app ./
EXPOSE 3000
# ใช้ migrate ก่อน start ทุกครั้ง (docs บอกให้รันทุก deploy และมันข้าม migration ที่ลงแล้ว)
CMD ["sh", "-c", "node db/migrate.mjs && npx next start -H 0.0.0.0 -p 3000"]