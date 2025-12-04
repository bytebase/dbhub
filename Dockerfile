FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace configuration and all package.json files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies (including frontend workspace)
RUN pnpm install

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# Use pnpm deploy to create a clean production node_modules
# This removes the .pnpm store and creates a flat node_modules structure
RUN pnpm deploy --filter=dbhub --prod --legacy /prod/dbhub

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy deployed production files (includes node_modules without pnpm overhead)
COPY --from=builder /prod/dbhub/node_modules ./node_modules
COPY --from=builder /prod/dbhub/package.json ./

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Expose ports
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production

# Run the server
ENTRYPOINT ["node", "dist/index.js"]
