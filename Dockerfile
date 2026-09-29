FROM node:20-alpine

WORKDIR /app

# Install dependencies for Prisma and bcrypt native modules
RUN apk add --no-cache openssl libc6-compat

# Copy workspace root and shared package
COPY package.json ./
COPY packages/shared ./packages/shared

# Copy server package
COPY packages/server/package.json ./packages/server/
RUN cd packages/server && npm install --production

# Copy server source and Prisma schema
COPY packages/server ./packages/server

# Generate Prisma client
RUN cd packages/server && npx prisma generate

# Expose broker port (configurable via PORT env)
EXPOSE 3001

# Run migrations then start the broker
CMD ["sh", "-c", "cd packages/server && npx prisma migrate deploy && node src/index.js"]
