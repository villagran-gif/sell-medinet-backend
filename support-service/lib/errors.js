export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { title: err.message, details: err.details },
    });
  }
  console.error("[support-service] unhandled error:", err);
  return res.status(500).json({
    error: { title: "Internal Server Error" },
  });
}
