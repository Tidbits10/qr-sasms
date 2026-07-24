import { PrismaClient } from "@prisma/client";

// Standard Next.js-recommended singleton so hot-reload in dev doesn't
// exhaust Postgres connections by creating a new PrismaClient per request.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
