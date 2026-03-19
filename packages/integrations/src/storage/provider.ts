export type PutObjectInput = {
  key: string;
  contentType: string;
  body: ReadableStream<Uint8Array> | Uint8Array;
};

export type StorageProvider = {
  putObject(input: PutObjectInput): Promise<{ key: string }>;
};

