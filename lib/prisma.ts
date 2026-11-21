import { PrismaClient } from '../app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { databaseUrl } from './database-env'

const globalForPrisma = global as unknown as {
    prisma: PrismaClient
}

const connectionString = databaseUrl();
if (process.env.VERCEL_ENV === 'preview' && !connectionString) {
  throw new Error('PREVIEW_DATABASE_URL is required for Vercel previews');
}

const adapter = new PrismaPg({
  connectionString,
  // Serverless against a transaction pooler (e.g. Supabase's :6543), which
  // absorbs far more clients than a direct connection would. A small pool
  // per instance lets parallel queries (the POS page loads in one
  // Promise.all batch) actually overlap; max: 1 serialized every query on a
  // single socket and made each reload pay ~15 round-trips in a queue.
  max: 4,
})

const prisma = globalForPrisma.prisma || new PrismaClient({
  adapter,
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
