import assert from "node:assert/strict";
import test from "node:test";
import { findFrontendI18nViolations } from "./frontend-i18n-guard.mjs";

test("rejects static product copy in JSX text and visible attributes", () => {
  const source = `
    export function Fixture() {
      return <section>
        <label>Bot Token</label>
        <strong>ICON</strong>
        <img alt="Icon" />
        <input placeholder={"Chat ID"} aria-label="API Key" title={\`Webhook URL\`} />
        <output aria-braillelabel="Visible braille copy" />
        <input placeholder="automatic" />
        <button aria-label={"Delete " + itemId} />
        <span>{"Static expression"}</span>
        <span>{enabled ? "Enabled copy" : translated}</span>
        <span>{pending && "Pending copy"}</span>
      </section>;
    }
  `;

  assert.deepEqual(
    findFrontendI18nViolations(source).map((violation) => violation.text),
    [
      "Bot Token",
      "ICON",
      "Icon",
      "Chat ID",
      "API Key",
      "Webhook URL",
      "Visible braille copy",
      "automatic",
      "Delete",
      "Static expression",
      "Enabled copy",
      "Pending copy",
    ],
  );
});

test("allows brands, protocol tokens and format examples", () => {
  const source = `
    export function Fixture() {
      return <section>
        <strong>Renewlet</strong>
        <strong>ServerChan</strong>
        <span>GET</span>
        <span>Markdown</span>
        <input placeholder="https://example.com/webhook" />
        <input placeholder="smtp.example.com" />
        <input placeholder="napi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
        <input placeholder="renewlet" />
        <input placeholder="auto" />
        <input placeholder="sk-..." />
        <input placeholder="#10B981" />
        <input placeholder="a@example.com, b@example.com" />
        <input placeholder={multiple ? "a@example.com, b@example.com" : "user@example.com"} />
        <span>v</span>
        <input aria-label="YYYY-MM-DD" />
        <div aria-hidden="true" aria-live="polite" aria-controls="settings-dialog" />
      </section>;
    }
  `;

  assert.deepEqual(findFrontendI18nViolations(source), []);
});
