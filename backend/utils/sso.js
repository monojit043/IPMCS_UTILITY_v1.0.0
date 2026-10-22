// ─────────────────────────────────────────────────────────────────────────────
// Single sign-on between ePULSE and MRCS (and any later module).
// IDENTICAL copy lives in every app — keep them in sync.
//
// One cookie, `eil_sso`, holds a signed token { sub: employeeId, exp }.
// Signed with HMAC-SHA256 using SSO_SECRET, which must be the SAME in every
// app's .env. Browsers share cookies by HOSTNAME (not port), so SSO works when
// the apps are opened through the same host, e.g. http://<host>:3300 (ePULSE)
// and http://<host>:5500 (MRCS).
//
// The cookie only says WHO is signed in. Each app still reads that user's
// active flag, department and roles live from PC-2 on every request.
// Signing out of any app clears the cookie → signed out of all apps.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");

const COOKIE_NAME = "eil_sso";
const MAX_AGE_MS  = 8 * 60 * 60 * 1000; // 8 hours

function secret() {
  const s = process.env.SSO_SECRET;
  if (!s || s.length < 32) throw new Error("SSO_SECRET missing or too short (min 32 chars) in .env");
  return s;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const hmac   = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function sign(employeeId) {
  const payload = b64url(JSON.stringify({ sub: String(employeeId), exp: Date.now() + MAX_AGE_MS }));
  return `${payload}.${hmac(payload)}`;
}

// Returns the employee ID if the token is genuine and not expired, else null
function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  let expected;
  try { expected = hmac(payload); } catch { return null; }
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return sub && exp > Date.now() ? sub : null;
  } catch { return null; }
}

function readCookie(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Employee ID of the signed-in user, or null
function currentUserId(req) {
  return verify(readCookie(req));
}

function setCookie(res, employeeId) {
  res.cookie(COOKIE_NAME, sign(employeeId), { httpOnly: true, sameSite: "lax", path: "/", maxAge: MAX_AGE_MS });
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", path: "/" });
}

module.exports = { COOKIE_NAME, sign, verify, currentUserId, setCookie, clearCookie };
