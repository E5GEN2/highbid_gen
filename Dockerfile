FROM node:22-slim

# System chromium + fonts/libs Playwright + Remotion need to render real
# YouTube pages (CJK / emoji / system fonts so screenshots aren't tofu;
# nss/atk/libdrm/libgbm are the runtime deps Chromium expects).
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    python3 \
    python3-pip \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && pip3 install --break-system-packages opencv-python-headless hdbscan umap-learn scikit-learn psycopg2-binary numpy \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Tell Playwright to skip its 130MB browser bundle download and use the
# system chromium installed above. lib/content-gen/yt-capture.ts respects
# this via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH when set.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV REMOTION_CHROME_EXECUTABLE=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN mkdir -p tmp/clip-cache tmp/renders
RUN npx next build

EXPOSE 8080

CMD ["npm", "run", "start"]