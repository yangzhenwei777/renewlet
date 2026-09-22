import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";

/** 登录态用户安全视图；密码 hash、reset token 和 session 元数据不能进入前端。 */
export interface AuthUserResponse {
  id: string;
  email: string;
  name: string;
  role: string;
  banned: boolean;
}

export interface SessionResponse {
  type: "session";
  // 浏览器 session token 只存在 HttpOnly cookie；响应只暴露过期时间和用户安全视图。
  session: { expiresAt: string };
  user: AuthUserResponse;
}

export type AuthenticatorMfaMethod = "totp" | "recovery_code";

export interface MfaRequiredResponse {
  type: "mfa_required";
  // ticketId 是短期二阶段凭据，不是 Bearer session；前端只能保存在登录页内存状态。
  ticketId: string;
  expiresAt: string;
  // Passkey 是独立登录凭据，不能被加入 MFA methods，否则会把无密码登录误降级成第二因素。
  methods: AuthenticatorMfaMethod[];
}

export type LoginResponse = SessionResponse | MfaRequiredResponse;

// 显式接口 + ZodType 让前端/Worker 共用契约，同时避免 type-aware ESLint 把跨包 z.infer 推成 error typed。
export const authUserSchema: z.ZodType<AuthUserResponse> = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  banned: z.boolean(),
}).strict();

export const sessionPayloadSchema = z.object({
  type: z.literal("session"),
  session: z.object({
    expiresAt: z.iso.datetime(),
  }).strict(),
  user: authUserSchema,
}).strict() satisfies z.ZodType<SessionResponse>;
export const sessionResponseSchema = apiSuccessResponseSchema(sessionPayloadSchema);

export const authenticatorMfaMethodSchema: z.ZodType<AuthenticatorMfaMethod> = z.enum(["totp", "recovery_code"]);

export const mfaRequiredPayloadSchema = z.object({
  type: z.literal("mfa_required"),
  ticketId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  methods: z.array(authenticatorMfaMethodSchema).min(1),
}).strict() satisfies z.ZodType<MfaRequiredResponse>;
export const mfaRequiredResponseSchema = apiSuccessResponseSchema(mfaRequiredPayloadSchema);

export const loginPayloadSchema = z.discriminatedUnion("type", [
  sessionPayloadSchema,
  mfaRequiredPayloadSchema,
]) satisfies z.ZodType<LoginResponse>;
export const loginResponseSchema = apiSuccessResponseSchema(loginPayloadSchema);

/** 首装创建管理员只能在后端再次确认 setup 可用时生效；schema 只负责请求形状和密码上限。 */
export const setupCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254),
  password: z.string().min(8).max(72),
}).strict();

/** 登录请求不接受额外字段；Turnstile token 只服务密码登录前置校验，不参与 Passkey/MFA 二阶段。 */
export const loginBodySchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(72),
  turnstileToken: z.string().trim().min(1).max(2048).optional(),
}).strict();

export const mfaStatusPayloadSchema = z.object({
  enabled: z.boolean(),
  // 身份验证器状态只描述 TOTP 与恢复码；Passkey 作为独立登录方式通过 passkeyCount 暴露。
  methods: z.array(authenticatorMfaMethodSchema),
  recoveryCodesRemaining: z.number().int().min(0),
  passkeyCount: z.number().int().min(0),
}).strict();
export const mfaStatusResponseSchema = apiSuccessResponseSchema(mfaStatusPayloadSchema);
export type MfaStatusResponse = z.infer<typeof mfaStatusPayloadSchema>;

export const mfaTotpSetupPayloadSchema = z.object({
  setupId: z.string().min(1),
  secret: z.string().min(1),
  otpauthUrl: z.string().min(1),
  expiresAt: z.iso.datetime(),
}).strict();
export const mfaTotpSetupResponseSchema = apiSuccessResponseSchema(mfaTotpSetupPayloadSchema);
export type MfaTotpSetupResponse = z.infer<typeof mfaTotpSetupPayloadSchema>;

export const mfaTotpEnableBodySchema = z.object({
  setupId: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/),
  currentPassword: z.string().min(1).max(72),
}).strict();
export type MfaTotpEnableBody = z.infer<typeof mfaTotpEnableBodySchema>;

export type MfaRecoveryCodesResponse = SessionResponse & {
  recoveryCodes: string[];
};

// 启用/重建恢复码属于账号安全状态切换：响应必须同时续签产品 session，避免旧 cookie session 被废弃后前端掉登录。
export const mfaRecoveryCodesPayloadSchema = sessionPayloadSchema.extend({
  recoveryCodes: z.array(z.string().min(1)).min(1),
}).strict() satisfies z.ZodType<MfaRecoveryCodesResponse>;
export const mfaRecoveryCodesResponseSchema = apiSuccessResponseSchema(mfaRecoveryCodesPayloadSchema);

export const mfaCurrentPasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(72),
}).strict();
export type MfaCurrentPasswordBody = z.infer<typeof mfaCurrentPasswordBodySchema>;

const webAuthnBase64UrlSchema = z.string().min(1).max(16_384);
const webAuthnCredentialTypeSchema = z.literal("public-key");
const webAuthnTransportSchema = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const webAuthnUserVerificationSchema = z.enum(["discouraged", "preferred", "required"]);
const webAuthnCredentialDescriptorSchema = z.object({
  id: webAuthnBase64UrlSchema,
  type: webAuthnCredentialTypeSchema,
  transports: z.array(webAuthnTransportSchema).default([]),
}).strict();
const webAuthnClientExtensionInputsSchema = z.object({
  credProps: z.boolean().default(false),
}).strict();
const webAuthnClientExtensionOutputsSchema = z.object({
  appid: z.boolean().optional(),
  credProps: z.object({ rk: z.boolean().optional() }).strict().optional(),
  hmacCreateSecret: z.boolean().optional(),
}).strict();

// Docker 与 Worker 使用不同 WebAuthn 库；shared 校验两者共同发送给浏览器的标准 JSON，而不是接受任意 record。
export const passkeyRegistrationOptionsSchema = z.object({
  rp: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }).strict(),
  user: z.object({
    id: webAuthnBase64UrlSchema,
    name: z.string().min(1),
    displayName: z.string(),
  }).strict(),
  challenge: webAuthnBase64UrlSchema,
  pubKeyCredParams: z.array(z.object({
    alg: z.number().int(),
    type: webAuthnCredentialTypeSchema,
  }).strict()).min(1),
  timeout: z.number().int().positive().default(60_000),
  excludeCredentials: z.array(webAuthnCredentialDescriptorSchema).default([]),
  authenticatorSelection: z.object({
    requireResidentKey: z.boolean().default(true),
    residentKey: z.literal("required").default("required"),
    userVerification: z.literal("required").default("required"),
  }).strict(),
  hints: z.array(z.enum(["hybrid", "security-key", "client-device"])).default([]),
  attestation: z.enum(["direct", "enterprise", "indirect", "none"]).default("none"),
  extensions: webAuthnClientExtensionInputsSchema.default({ credProps: false }),
}).strict();
export type PasskeyRegistrationOptions = z.infer<typeof passkeyRegistrationOptionsSchema>;

export const passkeyAuthenticationOptionsSchema = z.object({
  challenge: webAuthnBase64UrlSchema,
  timeout: z.number().int().positive().default(60_000),
  rpId: z.string().min(1),
  allowCredentials: z.array(webAuthnCredentialDescriptorSchema).default([]),
  userVerification: webAuthnUserVerificationSchema.default("required"),
  hints: z.array(z.enum(["hybrid", "security-key", "client-device"])).default([]),
}).strict();
export type PasskeyAuthenticationOptions = z.infer<typeof passkeyAuthenticationOptionsSchema>;

export const passkeyRegistrationResponseSchema = z.object({
  id: webAuthnBase64UrlSchema,
  rawId: webAuthnBase64UrlSchema,
  response: z.object({
    clientDataJSON: webAuthnBase64UrlSchema,
    attestationObject: webAuthnBase64UrlSchema,
    authenticatorData: webAuthnBase64UrlSchema.optional(),
    transports: z.array(webAuthnTransportSchema).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: webAuthnBase64UrlSchema.optional(),
  }).strict(),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: webAuthnClientExtensionOutputsSchema,
  type: webAuthnCredentialTypeSchema,
}).strict();
export type PasskeyRegistrationResponse = z.infer<typeof passkeyRegistrationResponseSchema>;

export const passkeyAuthenticationResponseSchema = z.object({
  id: webAuthnBase64UrlSchema,
  rawId: webAuthnBase64UrlSchema,
  response: z.object({
    clientDataJSON: webAuthnBase64UrlSchema,
    authenticatorData: webAuthnBase64UrlSchema,
    signature: webAuthnBase64UrlSchema,
    userHandle: webAuthnBase64UrlSchema.optional(),
  }).strict(),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: webAuthnClientExtensionOutputsSchema,
  type: webAuthnCredentialTypeSchema,
}).strict();
export type PasskeyAuthenticationResponse = z.infer<typeof passkeyAuthenticationResponseSchema>;

export const passkeySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
}).strict();
export type Passkey = z.infer<typeof passkeySchema>;

export const passkeysPayloadSchema = z.object({
  passkeys: z.array(passkeySchema),
}).strict();
export const passkeysResponseSchema = apiSuccessResponseSchema(passkeysPayloadSchema);
export type PasskeysResponse = z.infer<typeof passkeysPayloadSchema>;

export const passkeyRegistrationOptionsPayloadSchema = z.object({
  challengeId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  options: passkeyRegistrationOptionsSchema,
}).strict();
export const passkeyRegistrationOptionsResponseSchema = apiSuccessResponseSchema(passkeyRegistrationOptionsPayloadSchema);
export type PasskeyRegistrationOptionsResponse = z.infer<typeof passkeyRegistrationOptionsPayloadSchema>;

export const passkeyAuthenticationOptionsPayloadSchema = z.object({
  challengeId: z.string().min(1),
  expiresAt: z.iso.datetime(),
  options: passkeyAuthenticationOptionsSchema,
}).strict();
export const passkeyAuthenticationOptionsResponseSchema = apiSuccessResponseSchema(passkeyAuthenticationOptionsPayloadSchema);
export type PasskeyAuthenticationOptionsResponse = z.infer<typeof passkeyAuthenticationOptionsPayloadSchema>;

export const passkeyRegisterOptionsBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  currentPassword: z.string().min(1).max(72),
}).strict();
export type PasskeyRegisterOptionsBody = z.infer<typeof passkeyRegisterOptionsBodySchema>;

export const passkeyRegisterVerifyBodySchema = z.object({
  challengeId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  response: passkeyRegistrationResponseSchema,
}).strict();
export type PasskeyRegisterVerifyBody = z.infer<typeof passkeyRegisterVerifyBodySchema>;

export const passkeyAuthenticateOptionsBodySchema = z.object({
}).strict();
export type PasskeyAuthenticateOptionsBody = z.infer<typeof passkeyAuthenticateOptionsBodySchema>;

export const passkeyAuthenticateVerifyBodySchema = z.object({
  challengeId: z.string().min(1),
  response: passkeyAuthenticationResponseSchema,
}).strict();
export type PasskeyAuthenticateVerifyBody = z.infer<typeof passkeyAuthenticateVerifyBodySchema>;

export const passkeyDeleteBodySchema = z.object({
  currentPassword: z.string().min(1).max(72),
}).strict();
export type PasskeyDeleteBody = z.infer<typeof passkeyDeleteBodySchema>;

export const mfaVerifyBodySchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("totp"),
    ticketId: z.string().min(1),
    code: z.string().trim().regex(/^\d{6}$/),
  }).strict(),
  z.object({
    method: z.literal("recovery_code"),
    ticketId: z.string().min(1),
    code: z.string().trim().min(6).max(64),
  }).strict(),
]);
export type MfaVerifyBody = z.infer<typeof mfaVerifyBodySchema>;
