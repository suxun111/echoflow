import { Client } from 'minio'

export type MultipartPart = {
  partNumber: number
  etag: string
  sizeBytes: number
  lastModified?: Date
}

export type StoredObject = {
  bucket: string
  objectKey: string
  sizeBytes: number
  etag: string
  versionId: string | null
  contentType: string | null
  lastModified: Date
}

export type CompletedMultipart = { etag: string; versionId: string | null }

export interface MultipartStorageProvider {
  readonly bucket: string
  createMultipartUpload(objectKey: string, contentType: string): Promise<string>
  createPartUploadUrl(objectKey: string, providerUploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>
  listMultipartParts(objectKey: string, providerUploadId: string): Promise<MultipartPart[]>
  completeMultipartUpload(objectKey: string, providerUploadId: string, parts: MultipartPart[]): Promise<CompletedMultipart>
  abortMultipartUpload(objectKey: string, providerUploadId: string): Promise<void>
  statObject(objectKey: string, versionId?: string | null): Promise<StoredObject>
  createReadUrl(objectKey: string, expiresInSeconds: number, versionId?: string | null): Promise<string>
  remove(objectKey: string, versionId?: string | null): Promise<void>
  downloadFile(objectKey: string, filePath: string, versionId?: string | null): Promise<void>
  uploadFile(objectKey: string, filePath: string, contentType: string): Promise<StoredObject>
  bucketExists(): Promise<boolean>
  ensureBucket(): Promise<void>
  ensureVersioning(): Promise<void>
}

type MinioOptions = {
  endPoint: string
  port: number
  useSSL: boolean
  accessKey: string
  secretKey: string
  bucket: string
}

type RawUploadedPart = { part: number; etag: string; size: number; lastModified?: Date }

class MultipartClient extends Client {
  listUploadedParts(bucketName: string, objectName: string, uploadId: string) {
    return this.listParts(bucketName, objectName, uploadId) as Promise<RawUploadedPart[]>
  }
}

function metadataValue(metadata: Record<string, string | string[] | undefined>, key: string) {
  const value = metadata[key] ?? metadata[key.toLowerCase()]
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

export class MinioStorageProvider implements MultipartStorageProvider {
  readonly bucket: string
  private readonly client: MultipartClient

  constructor(options: MinioOptions) {
    this.bucket = options.bucket
    this.client = new MultipartClient({
      endPoint: options.endPoint,
      port: options.port,
      useSSL: options.useSSL,
      accessKey: options.accessKey,
      secretKey: options.secretKey,
    })
  }

  async createMultipartUpload(objectKey: string, contentType: string) {
    return this.client.initiateNewMultipartUpload(this.bucket, objectKey, { 'Content-Type': contentType })
  }

  async createPartUploadUrl(objectKey: string, providerUploadId: string, partNumber: number, expiresInSeconds: number) {
    return this.client.presignedUrl('PUT', this.bucket, objectKey, expiresInSeconds, {
      uploadId: providerUploadId,
      partNumber: String(partNumber),
    })
  }

  async listMultipartParts(objectKey: string, providerUploadId: string) {
    const parts = await this.client.listUploadedParts(this.bucket, objectKey, providerUploadId)
    return parts.map((part) => ({
      partNumber: part.part,
      etag: part.etag,
      sizeBytes: part.size,
      lastModified: part.lastModified,
    })).sort((left, right) => left.partNumber - right.partNumber)
  }

  async completeMultipartUpload(objectKey: string, providerUploadId: string, parts: MultipartPart[]) {
    const completed = await this.client.completeMultipartUpload(
      this.bucket,
      objectKey,
      providerUploadId,
      parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
    )
    return { etag: completed.etag, versionId: completed.versionId }
  }

  async abortMultipartUpload(objectKey: string, providerUploadId: string) {
    await this.client.abortMultipartUpload(this.bucket, objectKey, providerUploadId)
  }

  async statObject(objectKey: string, versionId?: string | null): Promise<StoredObject> {
    const stat = await this.client.statObject(this.bucket, objectKey, versionId ? { versionId } : undefined)
    return {
      bucket: this.bucket,
      objectKey,
      sizeBytes: stat.size,
      etag: stat.etag,
      versionId: stat.versionId ?? versionId ?? null,
      contentType: metadataValue(stat.metaData, 'content-type'),
      lastModified: stat.lastModified,
    }
  }

  async createReadUrl(objectKey: string, expiresInSeconds: number, versionId?: string | null) {
    return this.client.presignedGetObject(
      this.bucket,
      objectKey,
      expiresInSeconds,
      versionId ? { versionId } : undefined,
    )
  }

  async remove(objectKey: string, versionId?: string | null) {
    await this.client.removeObject(this.bucket, objectKey, versionId ? { versionId } : undefined)
  }

  async downloadFile(objectKey: string, filePath: string, versionId?: string | null) {
    await this.client.fGetObject(this.bucket, objectKey, filePath, versionId ? { versionId } : undefined)
  }

  async uploadFile(objectKey: string, filePath: string, contentType: string) {
    const uploaded = await this.client.fPutObject(this.bucket, objectKey, filePath, { 'Content-Type': contentType })
    return this.statObject(objectKey, uploaded.versionId)
  }

  bucketExists() {
    return this.client.bucketExists(this.bucket)
  }

  async ensureBucket() {
    if (!await this.client.bucketExists(this.bucket)) await this.client.makeBucket(this.bucket)
  }

  async ensureVersioning() {
    const current = await this.client.getBucketVersioning(this.bucket)
    if (current.Status !== 'Enabled') await this.client.setBucketVersioning(this.bucket, { Status: 'Enabled' })
  }
}
