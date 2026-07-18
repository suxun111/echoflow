import { Client } from 'minio'
import { randomUUID } from 'node:crypto'

export type UploadTarget = { objectKey: string; uploadUrl: string; expiresAt: string }
export interface StorageProvider {
  createUploadTarget(fileName: string, contentType: string): Promise<UploadTarget>
  createReadUrl(objectKey: string): Promise<string>
  remove(objectKey: string): Promise<void>
}

export class MemoryStorageProvider implements StorageProvider {
  async createUploadTarget(fileName: string, _contentType: string): Promise<UploadTarget> {
    const objectKey = `private/${randomUUID()}-${fileName}`
    return { objectKey, uploadUrl: `memory://upload/${objectKey}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
  }
  async createReadUrl(objectKey: string) { return `memory://read/${objectKey}` }
  async remove() { return Promise.resolve() }
}

export class MinioStorageProvider implements StorageProvider {
  constructor(private readonly client: Client, private readonly bucket: string) {}
  async createUploadTarget(fileName: string, _contentType: string): Promise<UploadTarget> {
    const objectKey = `private/${randomUUID()}-${fileName}`
    const uploadUrl = await this.client.presignedPutObject(this.bucket, objectKey, 15 * 60)
    return { objectKey, uploadUrl, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
  }
  async createReadUrl(objectKey: string) { return this.client.presignedGetObject(this.bucket, objectKey, 15 * 60) }
  async remove(objectKey: string) { await this.client.removeObject(this.bucket, objectKey) }
}
