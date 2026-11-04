// Blob storage abstraction for user uploads: filesystem (Bun) or R2 (Workers). Optional – the app works without it.
export interface StoredBlob { body: ReadableStream | ArrayBuffer | Uint8Array; contentType: string }
export interface BlobStore {
  put(key: string, body: Blob, contentType: string): Promise<void>;
  get(key: string): Promise<StoredBlob | null>;
}

let _store: BlobStore | null = null;
export function useBlobStore(s: BlobStore | null) { _store = s; }
export function blobStore(): BlobStore | null { return _store; }

/** R2 bucket binding (structural type to avoid a workers-types dependency). */
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ReadableStream | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
}
export function r2Store(bucket: R2BucketLike): BlobStore {
  return {
    async put(key, body, contentType) { await bucket.put(key, await body.arrayBuffer(), { httpMetadata: { contentType } }); },
    async get(key) { const o = await bucket.get(key); return o ? { body: o.body, contentType: o.httpMetadata?.contentType ?? "application/octet-stream" } : null; },
  };
}
