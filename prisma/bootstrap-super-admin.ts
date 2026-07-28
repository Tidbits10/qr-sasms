import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD || "";
  const name = (process.env.BOOTSTRAP_SUPER_ADMIN_NAME || "SSO Admin").trim();

  if (!email || !password) {
    console.log("Super Admin bootstrap skipped: credentials are not configured.");
    return;
  }
  if (password.length < 10) throw new Error("BOOTSTRAP_SUPER_ADMIN_PASSWORD must be at least 10 characters.");

  const existing = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" } });
  if (existing) {
    console.log("Super Admin bootstrap skipped: a Super Admin already exists.");
    return;
  }

  await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: "SUPER_ADMIN",
      name,
      approved: true,
      active: true,
    },
  });
  console.log(`Super Admin bootstrap complete for ${email}.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
