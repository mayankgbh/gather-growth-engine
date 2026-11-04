import { buildFooter, type FooterConfig } from "./policy";

/** Copy is plain text. Never interpret prospect research or saved copy as HTML. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function htmlLines(value: string): string {
  return escapeHtml(value).replace(/\r\n?/g, "\n").replace(/\n/g, "<br/>");
}

/** Keep a full text equivalent; the provider campaign API accepts one HTML body. */
export function renderManagedEmailContent(copy: string, footer: FooterConfig): { body: string; html: string } {
  const footerText = buildFooter(footer);
  return {
    body: `${copy}\n\n${footerText}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#202020">${htmlLines(copy)}</div>`
      + `<div style="margin-top:16px;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#595959">${htmlLines(footerText)}</div>`,
  };
}
