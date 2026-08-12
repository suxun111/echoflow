import { PrismaClient, UserRole } from '@prisma/client'

const database = new PrismaClient()

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('Production seeding is disabled')

  await database.user.upsert({
    where: { phone: '+8613800000000' },
    update: {},
    create: { phone: '+8613800000000', displayName: 'EchoFlow Admin', role: UserRole.ADMIN },
  })
}

seed().finally(() => database.$disconnect())
