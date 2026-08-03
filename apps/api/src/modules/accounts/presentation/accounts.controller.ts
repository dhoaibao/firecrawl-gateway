import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import type { SessionRequest } from "../../auth/domain/auth-session";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PlatformAdminGuard, OperatorMfaGuard, OperatorStepUpGuard } from "../../operator/presentation/operator.guards";
import { AccountsService } from "../application/accounts.service";
import type { User } from "../../../types";

const userCreateSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(12).max(256),
  is_admin: z.boolean().optional(),
});

const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().optional(),
  password: z.string().min(12).max(256).optional(),
  is_admin: z.boolean().optional(),
  status: z.enum(["active", "suspended", "blocked"]).optional(),
  suspended_until: z.string().datetime().nullable().optional(),
});

const suspendSchema = z.object({
  duration: z.number().positive(),
  unit: z.enum(["hours", "days", "weeks"]),
});

@Controller("admin/api/users")
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  async list() {
    const users = await this.accounts.listUsers();
    return { data: users.map(serializeUser) };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const user = await this.accounts.getUser(id);
    if (!user) throw new NotFoundUserException();
    return { data: serializeUser(user) };
  }

  @Post()
  @UseGuards(OperatorStepUpGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body(new ZodValidationPipe(userCreateSchema)) body: z.infer<typeof userCreateSchema>) {
    if (await this.accounts.findByEmail(body.email)) throw new ConflictException("User with this email already exists");
    const user = await this.accounts.createUser(body);
    return { data: serializeUser(user) };
  }

  @Patch(":id")
  @UseGuards(OperatorStepUpGuard)
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(userUpdateSchema)) body: z.infer<typeof userUpdateSchema>,
    @Req() request: SessionRequest,
  ) {
    rejectSelfMutation(request.authUser, id, body);
    if (body.suspended_until && Number.isNaN(Date.parse(body.suspended_until))) {
      throw new BadRequestException("suspended_until must be a valid date");
    }
    const user = await this.accounts.updateUser(id, {
      name: body.name,
      email: body.email,
      password: body.password,
      isAdmin: body.is_admin,
      status: body.status,
      suspendedUntil: body.suspended_until,
    });
    if (!user) throw new NotFoundUserException();
    return { data: serializeUser(user) };
  }

  @Post(":id/suspend")
  @UseGuards(OperatorStepUpGuard)
  async suspend(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(suspendSchema)) body: z.infer<typeof suspendSchema>,
    @Req() request: SessionRequest,
  ) {
    rejectSelfMutation(request.authUser, id, { status: "suspended" });
    const multiplier = { hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000 }[body.unit];
    const user = await this.accounts.updateUser(id, {
      status: "suspended",
      suspendedUntil: new Date(Date.now() + body.duration * multiplier).toISOString(),
    });
    if (!user) throw new NotFoundUserException();
    return { data: serializeUser(user) };
  }

  @Post(":id/block")
  @UseGuards(OperatorStepUpGuard)
  async block(@Param("id") id: string, @Req() request: SessionRequest) {
    rejectSelfMutation(request.authUser, id, { status: "blocked" });
    const user = await this.accounts.updateUser(id, { status: "blocked", suspendedUntil: null });
    if (!user) throw new NotFoundUserException();
    return { data: serializeUser(user) };
  }

  @Post(":id/activate")
  @UseGuards(OperatorStepUpGuard)
  async activate(@Param("id") id: string) {
    const user = await this.accounts.updateUser(id, { status: "active", suspendedUntil: null });
    if (!user) throw new NotFoundUserException();
    return { data: serializeUser(user) };
  }

  @Delete(":id")
  @UseGuards(OperatorStepUpGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string, @Req() request: SessionRequest): Promise<void> {
    rejectSelfMutation(request.authUser, id, {});
    const result = await this.accounts.deleteUser(id);
    if (result === "not_found") throw new NotFoundUserException();
    if (result === "last_admin") throw new BadRequestException("Cannot delete the last admin user");
  }
}

class NotFoundUserException extends NotFoundException {
  constructor() {
    super("User not found");
  }
}

function rejectSelfMutation(user: User | undefined, id: string, body: { is_admin?: boolean; status?: string }): void {
  if (user?.id !== id) return;
  if (body.is_admin === false) throw new BadRequestException("Cannot revoke your own admin rights");
  if (body.status === "blocked" || body.status === "suspended") throw new BadRequestException("Cannot block or suspend yourself");
}

function serializeUser(user: User): Omit<User, "password_hash"> {
  const { password_hash: _passwordHash, ...safeUser } = user;
  return safeUser;
}
