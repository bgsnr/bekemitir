FROM oven/bun:1-debian AS base
WORKDIR /app

# Install GDAL CLI tools (ogr2ogr, gdal_translate) for the async import worker
RUN apt-get update \
  && apt-get install -y --no-install-recommends gdal-bin ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src

# Pastikan direktori data & uploads dapat diakses oleh non-root user bun
RUN mkdir -p /app/data /app/uploads && chown -R bun:bun /app

USER bun
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
