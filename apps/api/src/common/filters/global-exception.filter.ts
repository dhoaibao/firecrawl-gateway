import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { rootLogger } from "../../logger";
import type { RequestWithId } from "../interceptors/request-id.interceptor";

function exceptionMessage(response: string | object): string {
  if (typeof response === "string") return response;
  if (!("message" in response)) return "Request failed";
  const message = response.message;
  return Array.isArray(message) ? message.join(", ") : String(message);
}

function isHealthPayload(response: string | object): response is Record<string, unknown> {
  return typeof response === "object" && "status" in response && !("statusCode" in response);
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<unknown>();
    const adapter = this.adapterHost.httpAdapter;
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception instanceof HttpException
      ? exception.getResponse()
      : "Internal server error";
    const healthPayload = isHealthPayload(exceptionResponse);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR && !healthPayload) {
      rootLogger.error({ err: exception, request_id: request.requestId }, "Gateway error");
    }
    const code = typeof exceptionResponse === "object" && exceptionResponse !== null && "code" in exceptionResponse && typeof exceptionResponse.code === "string" ? exceptionResponse.code : undefined;
    const body = healthPayload
      ? exceptionResponse
      : {
          success: false,
          error: exceptionMessage(exceptionResponse),
          ...(code ? { code } : {}),
          ...(request.requestId ? { requestId: request.requestId } : {}),
        };

    adapter.reply(response, body, status);
  }
}
