// Vendored from @earendil-works/pi-ai (packages/ai/src/utils/oauth/oauth-page.ts).
// See LICENSE.md in this directory. Logo replaced with a procway-neutral mark.

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><circle cx="400" cy="400" r="280" fill="none" stroke="#fff" stroke-width="32"/><path d="M260 400 L360 500 L540 320" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPage({ title, heading, message, details }) {
  const safeTitle = escapeHtml(title);
  const safeHeading = escapeHtml(heading);
  const safeMessage = escapeHtml(message);
  const safeDetails = details ? escapeHtml(details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main { width: 100%; max-width: 560px; display: flex; flex-direction: column; align-items: center; }
    .logo { width: 72px; height: 72px; display: block; margin-bottom: 24px; }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; color: var(--text); }
    p { margin: 0; line-height: 1.7; color: var(--text-dim); font-size: 15px; }
    .details { margin-top: 16px; font-family: var(--font-mono); font-size: 13px; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${safeHeading}</h1>
    <p>${safeMessage}</p>
    ${safeDetails ? `<div class="details">${safeDetails}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message) {
  return renderPage({
    title: "Authentication successful",
    heading: "Authentication successful",
    message
  });
}

export function oauthErrorHtml(message, details) {
  return renderPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details
  });
}
