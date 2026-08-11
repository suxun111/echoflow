import { Client } from 'minio'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

export type UploadTarget = { objectKey: string; uploadUrl: string; expiresAt: string }
export interface StorageProvider {
  createUploadTarget(fileName: string, contentType: string): Promise<UploadTarget>
  createReadUrl(objectKey: string, expiresSeconds?: number): Promise<string>
  stat(objectKey: string): Promise<{ size: number; contentType?: string }>
  download(objectKey: string, destination: string): Promise<void>
  upload(objectKey: string, sourcePath: string, contentType: string): Promise<void>
  remove(objectKey: string): Promise<void>
}

export class MemoryStorageProvider implements StorageProvider {
  async createUploadTarget(fileName: string, _contentType: string): Promise<UploadTarget> {
    const objectKey = `private/${randomUUID()}-${fileName}`
    return { objectKey, uploadUrl: `memory://upload/${objectKey}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
  }
  async createReadUrl(objectKey: string) { return `memory://read/${objectKey}` }
  async stat(objectKey: string): Promise<{ size: number; contentType?: string }> { throw new Error(`Memory storage does not contain ${objectKey}`) }
  async download(objectKey: string, destination: string) { throw new Error(`Memory storage cannot download ${objectKey} to ${destination}`) }
  async upload(objectKey: string, sourcePath: string, contentType: string) { throw new Error(`Memory storage cannot upload ${sourcePath} as ${objectKey} (${contentType})`) }
  async remove() { return Promise.resolve() }
}

export class MinioStorageProvider implements StorageProvider {
  constructor(private readonly client: Client, private readonly bucket: string) {}
  async createUploadTarget(fileName: string, _contentType: string): Promise<UploadTarget> {
    const objectKey = `private/${randomUUID()}-${fileName}`
    const uploadUrl = await this.client.presignedPutObject(this.bucket, objectKey, 15 * 60)
    return { objectKey, uploadUrl, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }
  }
  async createReadUrl(objectKey: string, expiresSeconds = 2 * 60 * 60) {
    return this.client.presignedGetObject(this.bucket, objectKey, expiresSeconds)
  }
  async stat(objectKey: string) {
    const object = await this.client.statObject(this.bucket, objectKey)
    const metadata = object.metaData ?? {}
    return { size: object.size, contentType: metadata['content-type'] ?? metadata['Content-Type'] }
  }
  async download(objectKey: string, destination: string) {
    await mkdir(dirname(destination), { recursive: true })
    const stream = await this.client.getObject(this.bucket, objectKey)
    await pipeline(stream, createWriteStream(destination))
  }
  async upload(objectKey: string, sourcePath: string, contentType: string) {
    await this.client.fPutObject(this.bucket, objectKey, sourcePath, { 'Content-Type': contentType })
  }
  async remove(objectKey: string) { await this.client.removeObject(this.bucket, objectKey) }
}

export function createMinioStorageProvider(input: {
  endpoint: string
  port: number
  accessKey: string
  secretKey: string
  bucket: string
  useSSL?: boolean
}): StorageProvider {
  return new MinioStorageProvider(new Client({
    endPoint: input.endpoint,
    port: input.port,
    useSSL: input.useSSL ?? false,
    accessKey: input.accessKey,
    secretKey: input.secretKey,
  }), input.bucket)
}
