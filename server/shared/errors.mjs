export class HttpError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
  }
}

export class JobCancelledError extends HttpError {
  constructor(message = "Job request was cancelled", options) {
    super(499, message, options);
    this.name = "JobCancelledError";
  }
}
