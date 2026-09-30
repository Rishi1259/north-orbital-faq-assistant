export interface EmbeddingProvider {
  embed(
    inputs: string[],
  ): Promise<number[][]>;
}
