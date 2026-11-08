# Static site: the app runs entirely in the browser and talks to your Jellyfin server directly,
# so the container only has to serve these files.
FROM nginx:alpine

COPY . /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ || exit 1
