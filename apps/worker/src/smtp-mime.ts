const MIME_BOUNDARY = "renewlet-notification-alternative";

/** SMTP 发送层的窄邮件输入；HTML 和 Text 已由 shared 邮件模板生成。 */
export interface SmtpEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** 已解析邮箱地址；raw 保留展示名用于 header，address 用于 SMTP envelope。 */
export interface Mailbox {
  raw: string;
  address: string;
}

/** 组装 multipart/alternative 邮件，确保 Cloudflare 邮件与 Go 邮件保持同语义 fallback。 */
export function composeEmail(email: SmtpEmail, from: Mailbox, to: Mailbox[], replyTo: Mailbox | null): string {
  const headers = [
    `From: ${formatMailboxHeader(from)}`,
    `To: ${to.map(formatMailboxHeader).join(", ")}`,
    `Subject: ${encodeHeader(email.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${MIME_BOUNDARY}"`,
  ];
  if (replyTo) headers.splice(2, 0, `Reply-To: ${formatMailboxHeader(replyTo)}`);
  // Cloudflare 邮件彻底切到 Go 同语义 HTML+Text；纯文本只作为 multipart fallback 保留。
  return `${headers.join("\r\n")}\r\n\r\n${composeAlternativeBody(email)}`;
}

/** SMTP DATA 阶段要求以额外点号转义正文行首点号，避免提前结束邮件体。 */
export function dotStuff(value: string): string {
  return normalizeCrlf(value)
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function composeAlternativeBody(email: SmtpEmail): string {
  return [
    `--${MIME_BOUNDARY}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeCrlf(email.text),
    `--${MIME_BOUNDARY}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeCrlf(email.html),
    `--${MIME_BOUNDARY}--`,
    "",
  ].join("\r\n");
}

function formatMailboxHeader(mailbox: Mailbox): string {
  const display = mailbox.raw.endsWith(">") ? mailbox.raw.slice(0, mailbox.raw.lastIndexOf("<")).trim().replace(/^"|"$/g, "") : "";
  if (!display) return mailbox.address;
  return `${encodeHeader(display)} <${mailbox.address}>`;
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

function encodeHeader(value: string): string {
  const safe = sanitizeHeader(value);
  return /^[\x20-\x7E]*$/.test(safe) ? safe : `=?UTF-8?B?${base64Utf8(safe)}?=`;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
