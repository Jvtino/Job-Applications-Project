/** Base class so callers can distinguish our failures from programmer errors. */
export class JdError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConnectorError extends JdError {
  constructor(
    message: string,
    code:
      'http_error' | 'timeout' | 'schema_mismatch' | 'rate_limited' | 'needs_key' | 'network_error',
    readonly httpStatus?: number,
  ) {
    super(message, code);
  }
}

export class ParseError extends JdError {
  constructor(message: string, code: 'unreadable_file' | 'no_text_content' | 'unsupported_format') {
    super(message, code);
  }
}

export class MigrationError extends JdError {
  constructor(message: string) {
    super(message, 'migration_failed');
  }
}
