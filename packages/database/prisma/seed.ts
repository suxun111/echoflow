import { PrismaClient, AssetStatus } from '@prisma/client'

const database = new PrismaClient()

async function seed() {
  const admin = await database.user.upsert({
    where: { phone: '13800000000' },
    update: {},
    create: { phone: '13800000000', displayName: 'Demo Admin', role: 'ADMIN' },
  })
  await database.videoAsset.upsert({
    where: { id: 'demo-british-coast' },
    update: {},
    create: {
      id: 'demo-british-coast', title: '英国海滨小镇的一天', creator: 'Evie English',
      coverUrl: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=1200&q=85',
      durationMs: 522000, category: '旅行', accent: '英音', level: 'A2', status: AssetStatus.PUBLISHED,
      rightsNote: `Seeded by ${admin.displayName}`,
    },
  })
}

seed().finally(() => database.$disconnect())
