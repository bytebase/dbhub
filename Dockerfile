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

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy only production files
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

RUN pnpm pkg set pnpm.onlyBuiltDependencies[0]=better-sqlite3
RUN pnpm add better-sqlite3
RUN node -e 'new require("better-sqlite3")(":memory:")'

# Install production dependencies only
RUN pnpm install --prod

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Expose ports
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production

# Run the server
ENTRYPOINT ["node", "dist/index.js"]
