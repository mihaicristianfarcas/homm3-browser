# Game server for Heroes III in the browser: the web server with the built game, and the VCMI lobby.
# Used by compose.yaml, see docs/hosting.md. Needs the built game in dist/: it is included in release
# downloads, or build it with scripts/build-vcmi.sh and scripts/package-web.mjs (see docs/building.md).

# --- VCMI lobby server, built from the vendored VCMI sources ------------------------------------
FROM ubuntu:24.04 AS lobby-build
RUN apt-get update \
	&& apt-get install -y --no-install-recommends cmake ninja-build g++ pkg-config \
		libboost-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libboost-date-time-dev \
		libsqlite3-dev zlib1g-dev libminizip-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY vcmi vcmi
COPY scripts/build-lobby.sh scripts/
RUN BUILD_DIR=/build scripts/build-lobby.sh

FROM ubuntu:24.04 AS lobby
RUN apt-get update \
	&& apt-get install -y --no-install-recommends sqlite3 \
		libboost-filesystem1.83.0 libboost-locale1.83.0 libboost-program-options1.83.0 libminizip1t64 \
	&& rm -rf /var/lib/apt/lists/*
# vcmilobby finds VCMI's config next to its executable; its database lives in /data
WORKDIR /lobby
COPY --from=lobby-build /build/bin/vcmilobby ./
COPY vcmi/config config
COPY vcmi/Mods Mods
COPY deploy/docker-lobby.sh /usr/local/bin/
ENV HOME=/data XDG_DATA_HOME=/data XDG_CACHE_HOME=/tmp XDG_CONFIG_HOME=/data/config
RUN mkdir /data && chown ubuntu:ubuntu /data
USER ubuntu
VOLUME /data
EXPOSE 3031
CMD ["docker-lobby.sh"]

# --- Web server: launcher, game and WebSocket bridge to the lobby ----------------------------------
FROM node:22-slim AS web
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY server/server.mjs server/
COPY dist dist
ENV PORT=8642 HOST=0.0.0.0 WEB_ROOT=/app/dist NET_TARGETS=lobby:3031=lobby:3031 LOBBY=lobby:3031
USER node
EXPOSE 8642
CMD ["node", "server/server.mjs"]
