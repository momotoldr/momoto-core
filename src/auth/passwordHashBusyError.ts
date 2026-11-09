/**
 * Thrown instead of joining a line too long to be worth waiting in. Answered as a 503.
 *
 * In its own file because `errorHandler` needs it, and importing `passwords.ts` there would
 * make the error handler depend on the whole server configuration.
 */
export class PasswordHashBusyError extends Error {
  constructor() {
    super('password_hash_busy')
  }
}
