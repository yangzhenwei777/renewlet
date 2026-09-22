import type { EmailBrandMark, EmailTemplateData, EmailTemplateItem } from "./email-template";

/**
 * renderEmailTemplate 渲染通知邮件 HTML。
 *
 * 模板输出同时供 Cloudflare Worker 和 Go 邮件语义对齐；所有用户内容必须经过 escapeHtml/escapeAttr，
 * 因为邮件客户端会执行各自的 HTML/CSS 兼容规则，不能依赖浏览器 CSP。
 */
export function renderEmailTemplate(data: EmailTemplateData): string {
  const titleBlock = renderTitleBlock(data);
  const bodyContent = renderBodyContent(data);
  const cta = data.cta ? renderCta(data) : "";
  const cardBottomPadding = data.showCardBottomPadding ? " padding-bottom:36px;" : "";

  // 邮件客户端仍以 table/inline style 为最稳妥的布局事实源；不要把主结构替换成 Web 页面里的 flex/grid。
  return `<!doctype html>
<html lang="${escapeAttr(data.lang)}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(data.title)}</title>
  <style>
    :root { color-scheme: light only; supported-color-schemes: light; }
    body, table, td, p, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    body { margin:0 !important; padding:0 !important; width:100% !important; background:${data.theme.background}; }
    @media screen and (max-width: 620px) {
      .email-container { width:100% !important; max-width:100% !important; }
      .email-outer-pad { padding:28px 0 !important; }
      .email-main-card { border-left:0 !important; border-right:0 !important; border-radius:0 !important; }
      .email-px { padding-left:24px !important; padding-right:24px !important; }
      .email-h1 { font-size:20px !important; line-height:28px !important; }
      .email-metric { font-size:34px !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background:${data.theme.background}; font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Inter,'Segoe UI',Roboto,sans-serif;">
  <div style="display:none; max-height:0; overflow:hidden; mso-hide:all; opacity:0; color:transparent; height:0; width:0; font-size:1px; line-height:1px;">${escapeHtml(data.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; background:${data.theme.background};">
    <tr>
      <td align="center" class="email-outer-pad" style="padding:40px 16px;">
        <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; border-collapse:separate; border-spacing:0;">
          <tr>
            <td class="email-px" style="padding:0 8px 24px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td align="left" valign="middle" style="vertical-align:middle;">
                    ${renderBrandLockup(data)}
                  </td>
                  <td align="right" valign="middle" style="vertical-align:middle;">
                    <span style="display:inline-block; padding:4px 10px; border-radius:6px; background:${data.theme.primarySoft}; color:${data.theme.primary}; font-size:11px; font-weight:700; line-height:16px;">${escapeHtml(data.statusLabel)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td class="email-main-card" style="background:${data.theme.surface}; border:1px solid ${data.theme.border}; border-radius:20px; overflow:hidden;${cardBottomPadding}">
              ${renderSummaryPanel(data)}
              ${titleBlock}
              ${bodyContent}
              ${cta}
            </td>
          </tr>

          ${renderFooter(data)}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderTitleBlock(data: EmailTemplateData): string {
  if (data.layoutMode === "test-status" || data.layoutMode === "reminder-list") return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td class="email-px" style="padding:24px 36px 0 36px;">
                    <h1 class="email-h1" style="margin:0; color:${data.theme.text}; font-size:22px; line-height:30px; font-weight:700;">${escapeHtml(data.title)}</h1>
                  </td>
                </tr>
              </table>`;
}

function renderBodyContent(data: EmailTemplateData): string {
  if (data.layoutMode === "reminder-list") return renderGroups(data);
  if (data.layoutMode === "empty-message" || data.layoutMode === "compact-message") return renderMessagePanel(data);
  return "";
}

function renderSummaryPanel(data: EmailTemplateData): string {
  const rows = renderSummaryRows(data);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td class="email-px" style="padding:36px 36px 0 36px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-summary-panel" style="width:100%; border-collapse:separate; border-spacing:0; background:${data.theme.surfaceMuted}; border:1px solid ${data.theme.border}; border-radius:12px;">
                      <tr>
                        <td style="padding:16px 16px 13px 16px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                            <tr>
                              <td valign="top" style="vertical-align:top;">
                                <div style="color:${data.theme.primary}; font-size:12px; font-weight:700; line-height:18px; text-transform:uppercase;">${escapeHtml(data.summary.eyebrow)}</div>
                                <div class="email-metric" style="margin-top:2px; color:${data.theme.primary}; font-size:34px; font-weight:800; line-height:38px;">${escapeHtml(data.summary.value)} <span style="color:${data.theme.muted}; font-size:16px; font-weight:700; line-height:20px;">${escapeHtml(data.summary.label)}</span></div>
                              </td>
                            </tr>
                          </table>
                          <div style="margin-top:10px; color:${data.theme.muted}; font-size:13px; line-height:20px;">${escapeHtml(data.summary.detail)}</div>
                          ${rows}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>`;
}

function renderBrandLockup(data: EmailTemplateData): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="email-brand-lockup" style="border-collapse:collapse;">
                      <tr>
                        <td align="center" valign="middle" style="vertical-align:middle;">${renderBrandMark(data.brand.headerMark, "email-brand-lockup-mark")}</td>
                        <td valign="middle" style="padding-left:10px; color:${data.theme.text}; font-size:14px; font-weight:700; line-height:20px;">${escapeHtml(data.brand.name)}</td>
                      </tr>
                    </table>`;
}

function renderBrandMark(mark: EmailBrandMark, className: string): string {
  // 邮件品牌标识用 table/inline style 复刻真实图形，不走 SVG/IMG/CID，避免客户端拦截和远程请求泄露。
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${mark.size}" height="${mark.size}" class="${className}" bgcolor="${mark.background}" style="width:${mark.size}px; height:${mark.size}px; border-collapse:separate; border-spacing:0; background:${mark.background}; border:1px solid ${mark.border}; border-radius:${mark.radius}px;">
                                  <tr>
                                    <td align="center" valign="middle" style="padding:0; vertical-align:middle;">
                                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                                        <tr>
                                          <td bgcolor="${mark.foreground}" style="width:${mark.topWidth}px; height:${mark.topHeight}px; border-radius:${mark.topRadius}px; background:${mark.foreground}; font-size:0; line-height:0;">&nbsp;</td>
                                          <td style="width:${mark.gap}px; font-size:0; line-height:0;">&nbsp;</td>
                                          <td bgcolor="${mark.accent}" style="width:${mark.dotSize}px; height:${mark.dotSize}px; border-radius:${mark.dotRadius}px; background:${mark.accent}; font-size:0; line-height:0;">&nbsp;</td>
                                        </tr>
                                        <tr>
                                          <td colspan="3" style="height:${mark.rowGap}px; font-size:0; line-height:0;">&nbsp;</td>
                                        </tr>
                                        <tr>
                                          <td colspan="3" style="padding-left:${mark.bottomInset}px;">
                                            <div style="width:${mark.bottomWidth}px; height:${mark.bottomHeight}px; border-radius:${mark.bottomRadius}px; background:${mark.accent}; font-size:0; line-height:0;">&nbsp;</div>
                                          </td>
                                        </tr>
                                      </table>
                                    </td>
                                  </tr>
                                </table>`;
}

function renderSummaryRows(data: EmailTemplateData): string {
  if (data.summary.rows.length === 0) return "";
  const rows = data.summary.rows
    .map((row, index) => `${index === 0 ? "" : `<span style="color:${data.theme.border}; padding:0 7px;">/</span>`}${escapeHtml(row.label)} <strong style="color:${data.theme.primary}; font-weight:800;">${escapeHtml(row.value)}</strong>`)
    .join("");
  return `<div style="margin-top:12px; padding-top:10px; border-top:1px solid ${data.theme.border}; color:${data.theme.muted}; font-size:12px; line-height:18px;">${rows}</div>`;
}

function renderGroups(data: EmailTemplateData): string {
  return data.groups.map((group, index) => `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td class="email-px" style="padding:${index === 0 ? "12px" : "8px"} 36px 0 36px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-group-card" style="width:100%; border-collapse:separate; border-spacing:0; background:${data.theme.surfaceMuted}; border:1px solid ${data.theme.border}; border-radius:12px;">
                      <tr>
                        <td style="padding:12px 16px 5px 16px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                            <tr>
                              <td align="left" style="color:${data.theme.text}; font-size:13px; font-weight:800; line-height:18px;">${escapeHtml(group.label)}</td>
                              <td align="right" style="color:${data.theme.muted}; font-size:12px; font-weight:700; line-height:18px;">${group.count}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      ${group.items.map((item, itemIndex) => renderGroupItem(data, item, itemIndex)).join("")}
                    </table>
                  </td>
                </tr>
              </table>`).join("");
}

function renderGroupItem(data: EmailTemplateData, item: EmailTemplateItem, index: number): string {
  const border = index === 0 ? "" : `border-top:1px solid ${data.theme.border};`;
  return `<tr>
                        <td style="padding:0 16px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse; ${border}">
                            <tr>
                              <td valign="top" style="padding:8px 0 7px 0; vertical-align:top;">
                                <p style="margin:0; color:${data.theme.text}; font-size:14px; font-weight:700; line-height:19px;">${escapeHtml(item.name)}</p>
                                <p style="margin:2px 0 0 0; color:${data.theme.muted}; font-size:12px; line-height:17px;">${escapeHtml(item.dateLabel)} · ${escapeHtml(item.targetDate)} · ${escapeHtml(item.detail)}</p>
                              </td>
                              <td align="right" valign="top" width="96" style="width:96px; padding:8px 0 7px 12px; vertical-align:top; text-align:right; white-space:nowrap;">
                                <p style="margin:0; color:${data.theme.text}; font-size:15px; font-weight:800; line-height:19px;">${escapeHtml(item.amount)}</p>
                                <p style="margin:1px 0 0 0; color:${data.theme.muted}; font-size:10px; font-weight:700; line-height:14px;">${escapeHtml(item.currency)}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>`;
}

function renderMessagePanel(data: EmailTemplateData): string {
  const panel = data.messagePanel;
  if (!panel) return "";
  const content = panel.lines.map(escapeHtml).join("<br>");
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td class="email-px" style="padding:0 36px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="email-message-panel" style="width:100%; border-collapse:separate; border-spacing:0; background:${data.theme.surfaceMuted}; border:1px solid ${data.theme.border}; border-radius:14px;">
                      <tr>
                        <td style="padding:18px 20px;">
                          <p style="margin:0 0 6px 0; color:${data.theme.text}; font-size:13px; font-weight:800; line-height:20px;">${escapeHtml(panel.label)}</p>
                          <p style="margin:0; color:${data.theme.muted}; font-size:14px; line-height:22px;">${content}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>`;
}

function renderCta(data: EmailTemplateData): string {
  const cta = data.cta;
  if (!cta) return "";
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td class="email-px" align="center" style="padding:28px 36px 36px 36px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:separate; border-spacing:0;">
                      <tr>
                        <td align="center" valign="middle" bgcolor="${data.theme.text}" style="background:${data.theme.text}; border-radius:12px;">
                          <a href="${escapeAttr(cta.url)}" style="display:block; color:#FFFFFF; font-size:15px; font-weight:700; line-height:48px; text-decoration:none;">${escapeHtml(cta.label)}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>`;
}

function renderFooter(data: EmailTemplateData): string {
  return `<tr>
            <td class="email-px" style="padding:28px 8px 8px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; border-collapse:collapse;">
                <tr>
                  <td align="center" style="color:#94A3B8; font-size:12px; line-height:20px;">
                    <strong style="color:${data.theme.muted}; font-weight:700;">${escapeHtml(data.copy.generatedAt)}</strong> ${escapeHtml(data.timestamp)}
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:8px; color:#94A3B8; font-size:12px; line-height:20px;">${escapeHtml(data.copy.footer)}</td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:18px; color:#94A3B8; font-size:11px; line-height:16px;">© Renewlet</td>
                </tr>
              </table>
            </td>
          </tr>`;
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
