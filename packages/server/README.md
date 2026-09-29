# Orchard Server

The backend server for Orchard that handles authentication, user presence tracking, and file transfer coordination.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env and set your configuration
   ```

3. **Generate Prisma client:**
   ```bash
   npx prisma generate
   ```

4. **Run database migrations:**
   ```bash
   npx prisma migrate dev
   ```

5. **Start the server:**
   ```bash
   node src/index.js
   ```

The server will start on port 3001 (or the port specified in `.env`).

## Environment Variables

Create a `.env` file in this directory with the following variables:

```env
# Server port
PORT=3001

# JWT secret for signing tokens (CHANGE THIS!)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# Database connection
DATABASE_URL=file:./prisma/dev.db

# CORS allowed origins (* for development, specific domains for production)
CORS_ORIGIN=*

# Trust proxy: set to 1 (or a specific IP/CIDR) when the broker runs behind a
# reverse proxy (Caddy, Nginx, etc.).  This enables X-Forwarded-For so that real
# client IPs are used for rate limiting and public-endpoint resolution.
# TRUST_PROXY=1

# Keep public user discovery disabled by default for invite-only networks.
# ENABLE_PUBLIC_USER_SEARCH=false

# User search endpoint abuse controls
# USER_SEARCH_RATE_WINDOW_MS=60000
# USER_SEARCH_RATE_MAX=30
```

### Generating a Secure JWT Secret

For production, generate a secure random secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Copy the output and set it as your `JWT_SECRET` in `.env`.

## Security Features

### Rate Limiting

The server implements rate limiting to prevent brute-force attacks:

- **Login endpoint**: Maximum 5 attempts per IP per 15 minutes
- **Registration endpoint**: Maximum 10 attempts per IP per 15 minutes
- Successful logins don't count toward the limit

### Authentication

- Passwords are hashed using bcrypt with 10 salt rounds
- JWT tokens expire after 24 hours
- Case-insensitive username validation prevents duplicates

### CORS Configuration

For development, `CORS_ORIGIN=*` allows all origins. For production, set specific domains:

```env
CORS_ORIGIN=https://yourdomain.com,https://www.yourdomain.com
```

## API Endpoints

### Public Endpoints

- `GET /` - Health check
- `POST /register` - Register new user (rate limited)
- `POST /login` - Authenticate user (rate limited)
- `POST /recovery/reset-password` - Reset password with saved recovery code (rate limited)

### Protected Endpoints (require JWT)

- `GET /buddies` - Get user's buddy list
- `POST /buddies` - Add a buddy
- `DELETE /buddies/:buddyId` - Remove a buddy
- `GET /admin/ops/diagnostics` - Incident-oriented operational diagnostics (admin only)

### Socket.IO Events

- `authenticate` - Authenticate socket connection
- `user:connected` - User comes online
- `user:disconnected` - User goes offline
- `file:list` - Share file list with other users
- `file:download:request` - Request to download a file
- `file:download:approved` - Download request approved
- `file:download:rejected` - Download request rejected
- `file:send` - Send a file directly to another user
- `file:incoming` - Receive a file from another user

## Database

The server uses Prisma with SQLite for development. The database file is located at `prisma/dev.db`.

### Migrations

To create a new migration after changing the schema:

```bash
npx prisma migrate dev --name your_migration_name
```

### Database Studio

To open Prisma Studio for database inspection:

```bash
npx prisma studio
```

## Production Deployment

Before deploying to production:

1. Generate a secure `JWT_SECRET`
2. Set `CORS_ORIGIN` to your specific domains
3. Consider using PostgreSQL or MySQL instead of SQLite
4. Enable HTTPS with a reverse proxy (nginx, Apache)
5. Keep dependencies updated (`npm audit` and `npm update`)
6. Monitor logs for security issues

See [SECURITY.md](../../SECURITY.md) for more security recommendations.

## Development

### Project Structure

```
server/
├── src/
│   └── index.js          # Main server file
├── prisma/
│   ├── schema.prisma     # Database schema
│   ├── dev.db           # SQLite database (gitignored)
│   └── migrations/      # Database migrations
├── .env                 # Environment variables (gitignored)
├── .env.example         # Environment variables template
├── package.json
└── README.md
```

### Adding New Features

1. Update the schema in `prisma/schema.prisma` if needed
2. Run `npx prisma migrate dev` to create a migration
3. Add your routes/socket handlers in `src/index.js`
4. Test with Postman or the Electron client

## Troubleshooting

### "Prisma Client did not initialize"

Run `npx prisma generate` to regenerate the Prisma client.

### Port already in use

Change the `PORT` in `.env` or kill the process using port 3001:

```bash
# Find the process
lsof -i :3001

# Kill it (replace PID with actual process ID)
kill -9 PID
```

### Database locked error

SQLite doesn't handle concurrent writes well. For production, use PostgreSQL or MySQL.

### Rate limit errors during testing

Rate limits are IP-based. If you're testing authentication, you may hit the limits. Wait 15 minutes or restart the server to reset.
