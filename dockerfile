# Use Node.js as the base image
FROM node:18

# Install required system dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    xdg-utils \
    wget \
    libx11-xcb1 \
    libxss1 \
    libgbm1 \
    libgtk-3-0 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libxkbcommon-x11-0 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*  # Reduce image size

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first for better caching
COPY package.json package-lock.json ./

# Install dependencies, including Puppeteer
RUN npm install --omit=dev && npm install puppeteer && \
    chmod -R 777 /root/.cache/puppeteer

# Copy the application source code
COPY . .

# Expose port 8080
EXPOSE 8080

# Start the application
CMD ["node", "vision.cjs"]
