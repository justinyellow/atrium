import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config.js';

/** Where uploaded files live. `key` is the path stored in files.path. */
export interface Storage {
  put(key: string, body: Readable, mime: string): Promise<number>;
  get(key: string): Promise<Readable | null>;
  check(): Promise<void>;
}

class LocalStorage implements Storage {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async put(key: string, body: Readable) {
    const ws = createWriteStream(join(this.dir, key));
    await pipeline(body, ws);
    return ws.bytesWritten;
  }
  async get(key: string) {
    const p = join(this.dir, key);
    return existsSync(p) ? createReadStream(p) : null;
  }
  async check() {}
}

class S3Storage implements Storage {
  // Credentials: default provider chain (ECS task role / instance profile / env). No static keys needed.
  private s3 = new S3Client({
    region: config.storage.awsRegion,
    endpoint: config.storage.s3Endpoint,
    forcePathStyle: config.storage.s3ForcePathStyle,
  });
  constructor(private bucket: string, private prefix: string) {}
  private k(key: string) {
    return `${this.prefix}${key}`;
  }
  async put(key: string, body: Readable, mime: string) {
    let size = 0;
    body.on('data', (c: Buffer) => (size += c.length));
    await new Upload({ client: this.s3, params: { Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: mime } }).done();
    return size;
  }
  async get(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return (r.Body as Readable) ?? null;
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async check() {
    // Readiness: a HEAD on a key that may not exist proves credentials + bucket reachability.
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k('.ready') }));
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return;
      throw e;
    }
  }
}

export const storage: Storage =
  config.storage.driver === 's3'
    ? new S3Storage(config.storage.s3Bucket!, config.storage.s3Prefix)
    : new LocalStorage(config.storage.localDir);
