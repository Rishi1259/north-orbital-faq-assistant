export type ModelProviderErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'invalid_response';

export class ModelProviderError extends Error {
  constructor(
    public readonly code: ModelProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelProviderError';
  }
}
