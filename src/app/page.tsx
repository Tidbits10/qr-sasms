import fs from "fs";
import path from "path";
import Script from "next/script";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// The entire original <body> markup (every #page-xxx section, modals, nav,
// toast container — all of it, including the embedded base64 logo images)
// lives untouched in src/content/body.html and is injected verbatim here.
// Zero HTML/CSS was rewritten; only the JavaScript behind it (public/app.js)
// was replaced to call the real API instead of localStorage.
export default function Home() {
  const bodyHtml = fs.readFileSync(path.join(process.cwd(), "src", "content", "body.html"), "utf8");

  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      {/* Rewired client logic — same global function names the inline
          onclick="..." handlers above already call (goTo, doLogin,
          submitRequest, adminAction, etc.), now backed by real API calls. */}
      <Script src="/app.js" strategy="afterInteractive" />
    </>
  );
}
