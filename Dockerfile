# syntax=docker/dockerfile:1

# Two stages: the build stage keeps devDependencies (vite, tsx, typescript)
# and the runtime stage keeps only what `npm start` actually needs.
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/command-center.db \
    TYPST_BIN=/usr/local/bin/typst

# Typst renders the resume PDF; step 3 of the agent plan fails without it.
ARG TYPST_VERSION=v0.13.1
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    case "$(dpkg --print-architecture)" in \
      amd64) typst_arch=x86_64-unknown-linux-musl ;; \
      arm64) typst_arch=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/typst/typst/releases/download/${TYPST_VERSION}/typst-${typst_arch}.tar.xz" \
      | tar -xJ -C /tmp; \
    install -m 0755 "/tmp/typst-${typst_arch}/typst" /usr/local/bin/typst; \
    rm -rf "/tmp/typst-${typst_arch}"; \
    apt-get purge -y curl xz-utils; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    typst --version

# The server runs from TypeScript through tsx, so the install comes over whole
# from the build stage rather than being resolved a second time here.
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY evals ./evals

# The SQLite file holds connector credentials — keep it on a volume, not in the image.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are idempotent, so running them on boot keeps a fresh volume working.
CMD ["sh", "-c", "npm run migrate && npm start"]
