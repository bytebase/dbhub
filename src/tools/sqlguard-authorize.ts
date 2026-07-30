/**
 * Optional SQLGuard Execution Certificate gate (env-gated).
 *
 * When SQLGUARD_REQUIRE is truthy, mutating SQL must present a verified PASS
 * certificate from https://sqlguard.io before write tools run.
 *
 * Env:
 *   SQLGUARD_REQUIRE=1   — fail-closed on mutating SQL without PASS
 *   SQLGUARD_BASE        — default https://sqlguard.io
 *   SQLGUARD_AGENT       — agent/wallet id for buy hints
 */

import type { ConnectorType } from "../connectors/interface.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";

export function requireEnabled(): boolean {
  const raw = (process.env.SQLGUARD_REQUIRE || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

/**
 * True when SQL is not classified read-only by DBHub's dialect-aware parser
 * (comment/string stripping, MySQL `--` rules, etc.).
 */
export function isMutating(sql: string, connectorType: ConnectorType | string = "postgres"): boolean {
  return !isReadOnlySQL(sql, connectorType);
}

function baseUrl(): string {
  return (process.env.SQLGUARD_BASE || "https://sqlguard.io").replace(/\/$/, "");
}

function agentId(): string {
  return (process.env.SQLGUARD_AGENT || "0xagent").trim();
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-SQLGuard-Agent": agentId(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      json = { raw: String(raw).slice(0, 200) };
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      json = { value: json };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

function buyHint(): string {
  const a = agentId();
  return (
    `Buy Instant Cert: POST ${baseUrl()}/v1/cert ($0.05 Exact USDC Base) or Session: POST ${baseUrl()}/v1/session ($0.25/10). ` +
    `Then POST ${baseUrl()}/v1/verify and pass certificate+signature. agent=${a}. See https://sqlguard.io/INTEGRATE.md`
  );
}

/** Redact verify payloads before surfacing to tool clients/logs. */
export function redactVerifyError(json: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const key of ["ok", "verified", "status", "error", "code", "message", "reason"]) {
    if (key in json) safe[key] = json[key];
  }
  if (json.certificate && typeof json.certificate === "object" && !Array.isArray(json.certificate)) {
    const c = json.certificate as Record<string, unknown>;
    safe.certificate_status = c.status;
  }
  return JSON.stringify(safe).slice(0, 400);
}

/**
 * Returns an error message string if blocked, else null.
 */
export async function gateMutatingSql(
  sql: string,
  certificate?: string | Record<string, unknown> | null,
  signature?: string | null,
  connectorType: ConnectorType | string = "postgres",
): Promise<string | null> {
  if (!requireEnabled()) return null;
  if (!isMutating(sql, connectorType)) return null;

  if (!certificate || !signature) {
    return (
      `SQLGUARD_REQUIRE: mutating SQL blocked without verified PASS certificate. ${buyHint()}`
    );
  }

  let certObj: Record<string, unknown>;
  if (typeof certificate === "string") {
    try {
      certObj = JSON.parse(certificate) as Record<string, unknown>;
    } catch {
      return "SQLGUARD_REQUIRE: certificate must be JSON object or JSON string.";
    }
  } else {
    certObj = certificate;
  }

  try {
    const { status, json } = await postJson("/v1/verify", {
      certificate: certObj,
      signature,
    });

    // Accept verify ok:true as PASS authorization
    if (status === 200 && json.ok === true) {
      return null;
    }

    const pass =
      status === 200 &&
      (json.verified === true ||
        String((json.certificate as Record<string, unknown>)?.status || json.status || "")
          .toUpperCase() === "PASS" ||
        json.status === "PASS");

    if (pass) return null;

    return (
      `SQLGUARD_REQUIRE: verify failed (HTTP ${status}): ${redactVerifyError(json)}. ${buyHint()}`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `SQLGUARD_REQUIRE: verify unreachable (${msg}). ${buyHint()}`;
  }
}
