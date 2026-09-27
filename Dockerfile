FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git zip unzip tar gzip nano bash curl wget ca-certificates \
    python3 python3-pip \
    make g++ clang pkg-config \
    libvips-dev libglib2.0-dev \
    libjpeg-dev libturbojpeg0-dev libpng-dev libwebp-dev librsvg2-dev \
    fontconfig fonts-dejavu-core \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages -U yt-dlp \
    || pip3 install -U yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
