export type NodeEnv = "development" | "test" | "production";

export type AppConfig = {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  redisUrl: string;
  s3: {
    endpoint: string;
    region: string;
    bucketUploads: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  aiGateway: {
    baseUrl: string;
    apiKey: string;
  };
};

