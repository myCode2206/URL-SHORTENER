// An error the API is allowed to show to clients. Anything that is not an
// AppError is treated as a bug and reported as a generic 500, so internal
// details (stack traces, SQL, file paths) never leak into responses.
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
