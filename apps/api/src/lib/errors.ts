import { ERROR_HTTP_STATUS, type ErrorCode } from "@trato/shared";

export class AppError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export const notFound = (message = "No encontramos lo que buscas."): AppError => new AppError("NOT_FOUND", message);
export const invalidState = (message: string): AppError => new AppError("INVALID_STATE", message);
export const forbidden = (message: string): AppError => new AppError("FORBIDDEN", message);
export const unauthorized = (message = "Inicia sesión para continuar."): AppError =>
  new AppError("UNAUTHORIZED", message);
