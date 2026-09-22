/**
 * 管理员用户页共享类型。
 *
 * 架构位置：页面 controller 持有状态，row/dialog presentation 只消费这些显式 interface，
 * 避免在 UI 组件之间传递宽松对象。
 *
 * 注意： AdminPatchUserPayload 必须与后端 adminPatchUserRequest、Zod schema 同步。
 * newPassword 只用于管理员重置他人密码；当前用户改密必须走 /account/password 并校验当前密码。
 */
import type { AdminUser, UserRole } from "@/lib/api/schemas/admin";

export interface LoadUsersOptions {
  signal?: AbortSignal;
  initial?: boolean;
}

export interface CreateUserFormState {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  role: UserRole;
}

export type CreateUserErrors = Partial<Record<keyof CreateUserFormState, string>>;
export type ResetPasswordErrors = Partial<Record<"password" | "confirmPassword", string>>;

export type AdminPatchUserPayload =
  | { role: UserRole }
  | { banned: boolean }
  | { newPassword: string };

export const DEFAULT_CREATE_FORM: CreateUserFormState = {
  name: "",
  email: "",
  password: "",
  confirmPassword: "",
  role: "user",
};

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEnabledAdmin(user: AdminUser) {
  return user.role === "admin" && !user.banned;
}
