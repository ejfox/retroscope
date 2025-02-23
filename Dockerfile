FROM node:20-slim

# Install necessary system tools
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Create a non-root user
RUN useradd -m retroscope && \
    chown -R retroscope:retroscope /app && \
    mkdir -p /app/logs && \
    chown -R retroscope:retroscope /app/logs

USER retroscope

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["npm", "start"] 