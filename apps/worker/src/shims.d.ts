/** Типы для зависимостей @tendery/extraction без своих .d.ts (tsc тянет исходники воркером). */
declare module "word-extractor" {
  export default class WordExtractor {
    extract(path: string): Promise<{ getBody(): string }>;
  }
}
