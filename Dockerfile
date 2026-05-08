# ──────────────────────────────────────────────────────────────
# NestMind AI — Production Dockerfile
# Includes: Node.js app + Python + Chrome + Xvfb (virtual display)
# ──────────────────────────────────────────────────────────────

FROM node:18-bookworm-slim AS base

# ── System deps: Chrome, Python, Xvfb ────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chrome + dependencies
    wget gnupg ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxrandr2 xdg-utils \
    # Virtual framebuffer (fake display for non-headless Chrome on cloud)
    xvfb \
    # Python for undetected-chromedriver
    python3 python3-pip python3-venv \
    # Misc
    dumb-init procps \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome stable
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages ──────────────────────────────────────────
# pikepdf needs libqpdf-dev for XFA PDF form filling (LTB N-forms)
RUN apt-get update && apt-get install -y --no-install-recommends libqpdf-dev && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages \
    undetected-chromedriver \
    selenium \
    PyVirtualDisplay \
    google-generativeai \
    pikepdf

# ── App setup ────────────────────────────────────────────────
WORKDIR /app

# Install Node.js dependencies (include devDeps — ts-node & prisma CLI are needed at runtime)
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force

# Copy Prisma schema & generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source
COPY . .

# Build TypeScript at build time (much faster startup)
RUN rm -rf dist && npm run build

# ── Runtime ──────────────────────────────────────────────────
ENV NODE_ENV=production
ENV AGENTIC_MODE=true
# Chrome needs this on Linux to find the display (Xvfb sets it)
ENV DISPLAY=:99

# Expose port
EXPOSE 3000

# Start Xvfb + the Node app
# dumb-init handles PID 1 / signal forwarding properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 -ac &>/dev/null & sleep 1 && npx prisma db push --accept-data-loss && node dist/index.js"]
