import { connect } from "cloudflare:sockets";
import { z } from "zod";
import { type AppLocale } from "./http";
import { serverFormat, serverText } from "./server-i18n";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { base64Utf8, composeEmail, dotStuff, type Mailbox, type SmtpEmail } from "./smtp-mime";

const DEFAULT_EHLO_DOMAIN = "renewlet.local";
const SUPPORTED_AUTH_METHOD = "PLAIN";

const emailAddressSchema = z.email();

/** 账号级 SMTP 配置；Cloudflare Worker 不读取部署级 SMTP secrets，也不支持 25 端口提交路径。 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  replyTo: string;
  authMethod: typeof SUPPORTED_AUTH_METHOD;
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

class SmtpProtocolError extends Error {
  constructor(
    readonly code: number,
    readonly lines: string[],
  ) {
    super(`SMTP ${code}: ${lines.join(" ")}`);
    this.name = "SmtpProtocolError";
  }
}

class SmtpConnection {
  private socket: Socket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(socket: Socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
  }

  async command(command: string, expectedCodes: readonly number[], locale: AppLocale): Promise<SmtpResponse> {
    await this.writeRaw(`${command}\r\n`);
    return await this.readResponse(expectedCodes, locale);
  }

  /**
   * 读取 SMTP 多行响应。
   *
   * SMTP 用 `250-...` 表示还有后续行、`250 ...` 表示结束；如果只读第一行会漏掉
   * STARTTLS/AUTH 能力，从而误判服务器安全能力。
   */
  async readResponse(expectedCodes: readonly number[], locale: AppLocale): Promise<SmtpResponse> {
    const lines: string[] = [];
    let code = 0;
    while (true) {
      const line = await this.readLine(locale);
      const match = /^(\d{3})([- ])(.*)$/.exec(line);
      if (!match) throw new Error(serverText(locale, "smtp.malformedResponse"));
      code = Number.parseInt(match[1] ?? "0", 10);
      lines.push(match[3] ?? "");
      if (match[2] === " ") break;
    }
    if (!expectedCodes.includes(code)) throw new SmtpProtocolError(code, lines);
    return { code, lines };
  }

  async writeData(data: string): Promise<void> {
    // DATA 阶段必须 dot-stuffing，否则正文里单独一行 "." 会被 SMTP 服务器当成邮件结束。
    await this.writeRaw(`${dotStuff(data)}\r\n.\r\n`);
  }

  upgradeTls(expectedServerHostname: string): SmtpConnection {
    this.reader.releaseLock();
    this.writer.releaseLock();
    return new SmtpConnection(this.socket.startTls({ expectedServerHostname }));
  }

  async close(): Promise<void> {
    await this.socket.close();
  }

  private async writeRaw(value: string): Promise<void> {
    await this.writer.write(this.encoder.encode(value));
  }

  private async readLine(locale: AppLocale): Promise<string> {
    while (!this.buffer.includes("\n")) {
      const result = await this.reader.read();
      if (result.done) throw new Error(serverText(locale, "smtp.responseClosed"));
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
    const index = this.buffer.indexOf("\n");
    const line = this.buffer.slice(0, index).replace(/\r$/, "");
    this.buffer = this.buffer.slice(index + 1);
    return line;
  }
}

/** 将账号级设置转换为 Cloudflare SMTP 配置；部署级 SMTP secrets 不参与 Worker 邮件通知。 */
export function notificationSmtpConfig(settings: ApiAppSettings, locale: AppLocale): SmtpConfig {
  // Cloudflare 版邮件只读取账号级设置；wrangler vars/secrets 不作为通知 SMTP 回退。
  return buildSmtpConfig(
    settings.smtpHost,
    settings.smtpPort,
    settings.smtpSecure,
    settings.smtpUser,
    settings.smtpPassword,
    settings.smtpFrom,
    settings.smtpReplyTo,
    SUPPORTED_AUTH_METHOD,
    locale,
  );
}

/**
 * 通过 Cloudflare TCP sockets 发送 SMTP 邮件。
 *
 * 连接先完成 EHLO/STARTTLS，再进行 AUTH 与 DATA；失败信息会被 publicSmtpError 清洗后返回给 UI。
 */
export async function sendSmtpEmail(config: SmtpConfig, email: SmtpEmail, locale: AppLocale): Promise<void> {
  // Workers TCP sockets 不支持把 25 端口当常规 submission 路径；端口合法性在 buildSmtpConfig 里统一拦截。
  const to = email.to.map((item) => parseMailbox(item, locale));
  if (to.length === 0) throw new Error(serverText(locale, "smtp.recipientEmpty"));
  const from = parseMailbox(config.from, locale);
  const replyTo = config.replyTo ? parseMailbox(config.replyTo, locale) : null;
  let connection = new SmtpConnection(connect(
    { hostname: config.host, port: config.port },
    {
      // Cloudflare 的 STARTTLS 必须在 socket 建立时声明；否则后续 startTls() 无法升级同一条连接。
      secureTransport: config.secure ? "on" : "starttls",
      allowHalfOpen: false,
    },
  ));

  try {
    await connection.readResponse([220], locale);
    const hello = await connection.command(`EHLO ${DEFAULT_EHLO_DOMAIN}`, [250], locale);
    if (!config.secure) {
      if (!supportsCapability(hello, "STARTTLS")) {
        throw new Error(serverText(locale, "smtp.startTlsMissing"));
      }
      await connection.command("STARTTLS", [220], locale);
      connection = connection.upgradeTls(config.host);
    }
    // 认证和正文只在 TLS 建立后发送；用户配置的 SMTP 密码绝不能跑在明文 socket 上。
    await deliverAfterTls(connection, config, email, from, to, replyTo, locale);
  } catch (error) {
    throw new Error(publicSmtpError(error, locale));
  } finally {
    await connection.close().catch(() => undefined);
  }
}

export function publicSmtpError(error: unknown, locale: AppLocale): string {
  if (error instanceof SmtpProtocolError) return `SMTP ${error.code}: ${sanitizeProviderText(error.lines.join(" "))}`;
  const message = error instanceof Error ? error.message : String(error);
  return `${serverText(locale, "smtp.deliveryFailed")}: ${sanitizeProviderText(message)}`;
}

async function deliverAfterTls(
  connection: SmtpConnection,
  config: SmtpConfig,
  email: SmtpEmail,
  from: Mailbox,
  to: Mailbox[],
  replyTo: Mailbox | null,
  locale: AppLocale,
): Promise<void> {
  const hello = await connection.command(`EHLO ${DEFAULT_EHLO_DOMAIN}`, [250], locale);
  if (config.username) {
    if (!supportsAuthPlain(hello)) throw new Error(serverText(locale, "smtp.serverAuthPlainUnsupported"));
    await connection.command(`AUTH PLAIN ${base64Utf8(`\0${config.username}\0${config.password}`)}`, [235], locale);
  }
  await connection.command(`MAIL FROM:<${from.address}>`, [250], locale);
  for (const recipient of to) {
    await connection.command(`RCPT TO:<${recipient.address}>`, [250, 251], locale);
  }
  await connection.command("DATA", [354], locale);
  await connection.writeData(composeEmail(email, from, to, replyTo));
  await connection.readResponse([250], locale);
  await connection.command("QUIT", [221], locale).catch(() => undefined);
}

function buildSmtpConfig(
  hostRaw: string,
  portRaw: string,
  secure: boolean,
  usernameRaw: string,
  passwordRaw: string,
  fromRaw: string,
  replyToRaw: string,
  authMethodRaw: string,
  locale: AppLocale,
): SmtpConfig {
  const host = hostRaw.trim();
  const from = fromRaw.trim();
  const replyTo = replyToRaw.trim();
  if (!host || !portRaw.trim() || !from) {
    throw new Error(serverText(locale, "smtp.incomplete"));
  }
  const port = Number.parseInt(portRaw.trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || String(port) !== portRaw.trim()) {
    throw new Error(serverText(locale, "smtp.invalidPort"));
  }
  if (port === 25) {
    // 这是 Cloudflare 平台限制，不写进 shared schema，避免误伤 Docker/VPS 上可自行放行的部署。
    throw new Error(serverText(locale, "smtp.port25Unsupported"));
  }
  const username = usernameRaw.trim();
  const password = passwordRaw.trim();
  if (Boolean(username) !== Boolean(password)) {
    throw new Error(serverText(locale, "smtp.usernamePasswordTogether"));
  }
  const authMethod = authMethodRaw.trim().toUpperCase() || SUPPORTED_AUTH_METHOD;
  if (authMethod !== SUPPORTED_AUTH_METHOD) {
    throw new Error(serverText(locale, "smtp.authPlainUnsupported"));
  }
  return { host, port, secure, username, password, from, replyTo, authMethod: SUPPORTED_AUTH_METHOD };
}

function parseMailbox(raw: string, locale: AppLocale): Mailbox {
  const trimmed = raw.trim();
  const match = /<([^<>]+)>$/.exec(trimmed);
  const address = (match?.[1] ?? trimmed).trim();
  if (!emailAddressSchema.safeParse(address).success) {
    throw new Error(serverFormat(locale, "smtp.invalidMailbox", { address: raw }));
  }
  return { raw: trimmed, address };
}

function supportsCapability(response: SmtpResponse, capability: string): boolean {
  return response.lines.some((line) => line.toUpperCase().startsWith(capability));
}

function supportsAuthPlain(response: SmtpResponse): boolean {
  return response.lines.some((line) => /^AUTH\b/i.test(line) && /\bPLAIN\b/i.test(line));
}

function sanitizeProviderText(value: string): string {
  return value
    .replace(/AUTH\s+PLAIN\s+\S+/gi, "AUTH PLAIN [redacted]")
    .replace(/[A-Za-z0-9+/=]{32,}/g, "[redacted]")
    .slice(0, 500);
}
