export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resource not found.');
