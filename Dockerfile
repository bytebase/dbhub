# ============================================================================
# Builder Stage: Build application and prepare dependencies
# ============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace configuration and all package.json files
# This is required for pnpm workspaces to resolve dependencies correctly
# for both the root package and the frontend package
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/

# Install pnpm using corepack (built into Node.js 22)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install all dependencies (both root and frontend workspace)
# This includes devDependencies needed for building
RUN pnpm install

# Copy source code
COPY . .

# Build the application
# This runs: generate API types → build backend (tsup) → build frontend (vite)
RUN pnpm run build

# Deploy production dependencies to a clean directory
# - --filter=dbhub: Only deploy dependencies for the main package (not frontend)
# - --prod: Only production dependencies (no devDependencies)
# - --legacy: Use legacy deploy mode for pnpm v10 workspace compatibility
# This creates a more efficient node_modules structure
# by copying only what's needed from the pnpm store to /prod/dbhub
RUN pnpm deploy --filter=dbhub --prod --legacy /prod/dbhub

# ============================================================================
# Production Stage: Minimal runtime image
# ============================================================================
FROM node:22-alpine

WORKDIR /app

# Copy optimized production dependencies from deploy directory
# This includes node_modules with an efficient .pnpm store structure
# Smaller than a standard pnpm install --prod
COPY --from=builder /prod/dbhub/node_modules ./node_modules
COPY --from=builder /prod/dbhub/package.json ./

# Copy built application from builder stage
# This includes both backend (dist/*.js) and frontend (dist/public/*)
COPY --from=builder /app/dist ./dist

# Expose the HTTP server port
# The server listens on this port when started with --transport=http
EXPOSE 8080

# Set NODE_ENV to production for optimal runtime behavior
ENV NODE_ENV=production

# Run the MCP server
# By default, uses stdio transport for MCP protocol communication
# Override with --transport=http for HTTP-based MCP clients
ENTRYPOINT ["node", "dist/index.js"]
