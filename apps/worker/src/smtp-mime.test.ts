// SMTP MIME 测试保护 Worker 邮件 multipart/alternative、header 编码和 dot-stuffing，避免通知邮件被注入或截断。
import { describe, expect, it } from "vitest";
import { composeEmail, dotStuff, type Mailbox, type SmtpEmail } from "./smtp-mime";

const from: Mailbox = { raw: "Renewlet 通知 <from@example.com>", address: "from@example.com" };
const to: Mailbox[] = [
  { raw: "User <user@example.com>", address: "user@example.com" },
  { raw: "second@example.com", address: "second@example.com" },
];

describe("composeEmail", () => {
  it("builds a multipart alternative message with text and html parts", () => {
    const body = composeEmail(email(), from, to, null);

    expect(body).toContain('Content-Type: multipart/alternative; boundary="renewlet-notification-alternative"');
    expect(body).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(body).toContain("Content-Type: text/html; charset=UTF-8");
    expect(body).toContain("Plain body\r\nNext line");
    expect(body).toContain("<strong>HTML body</strong>\r\nNext line");
    expect(body).toContain("--renewlet-notification-alternative--");
  });

  it("encodes non-ascii headers and sanitizes header newlines", () => {
    const body = composeEmail({
      ...email(),
      subject: "续费提醒\r\nBcc: leak@example.com",
    }, from, to, { raw: "回复 <reply@example.com>", address: "reply@example.com" });

    expect(body).toContain("From: =?UTF-8?B?");
    expect(body).toContain("Reply-To: =?UTF-8?B?");
    expect(body).toContain("Subject: =?UTF-8?B?");
    expect(body).not.toContain("\r\nBcc:");
  });
});

describe("dotStuff", () => {
  it("normalizes CRLF and escapes smtp data terminator lines", () => {
    // SMTP DATA 以单点行结束；正文里的点行必须 dot-stuff，否则邮件会在传输层被截断。
    expect(dotStuff("one\n.two\r\nthree")).toBe("one\r\n..two\r\nthree");
  });
});

function email(): SmtpEmail {
  return {
    to: ["user@example.com", "second@example.com"],
    subject: "Renewlet reminder",
    text: "Plain body\nNext line",
    html: "<strong>HTML body</strong>\nNext line",
  };
}
