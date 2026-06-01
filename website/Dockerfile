# Serves the pre-built Astro static output via nginx.
#
# NOTE: `dist/` is produced by the CD workflow (pnpm --filter @tasca/website
# build) BEFORE `docker build` runs — this image only packages the result, it
# does not build the site. Build context is the `website/` directory.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD wget --spider -q http://127.0.0.1/ || exit 1
