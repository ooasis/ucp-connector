/** Thrown to short-circuit a request into a UCP error envelope. */
export class UcpError extends Error {
  constructor(
    public readonly http: number,
    public readonly ucpCode: string,
    public readonly content: string,
    public readonly severity: string = 'unrecoverable',
  ) {
    super(content);
  }
}

/** RFC 9421 verification failure with a spec reason code. */
export class SignatureError extends Error {
  constructor(
    public readonly reason: string,
    detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}
