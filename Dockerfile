# Image for the stdio entrypoint, for local MCP clients that spawn a subprocess.
# The Vercel deployment does not use this file — it builds api/mcp.ts directly.
FROM node:22-alpine

WORKDIR /app

COPY package*.json tsconfig.json tsconfig.build.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Drop dev dependencies now that the build is done.
RUN npm prune --omit=dev

# No `2>&1`: stdout is the MCP wire on this transport, so stderr must stay
# separate or log output corrupts the JSON-RPC stream.
CMD ["node", "dist/index.js"]
