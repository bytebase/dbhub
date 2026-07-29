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

const MUTATING =
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|REFRESH)\b/i;

export function requireEnabled(): boolean {
  const raw = (process.env.SQLGUARD_REQUIRE || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export function isMutating(sql: string): boolean {
  let cleaned = sql.replace(/--.*?$/gm, " ");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, " ");
  return MUTATING.test(cleaned || "");
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
      json = { raw };
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

/**
 * Returns an error message string if blocked, else null.
 */
export async function gateMutatingSql(
  sql: string,
  certificate?: string | Record<string, unknown> | null,
  signature?: string | null,
): Promise<string | null> {
  if (!requireEnabled()) return null;
  if (!isMutating(sql)) return null;

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
    const ok = status === 200 && (json.ok === true || json.verified === true);
    const pass =
      ok &&
      (String((json.certificate as Record<string, unknown>)?.status || json.status || "")
        .toUpperCase() === "PASS" ||
        json.status === "PASS" ||
        json.ok === true);

    // Accept verify ok:true as PASS authorization
    if (status === 200 && json.ok === true) {
      return null;
    }
    if (pass) return null;

    return (
      `SQLGUARD_REQUIRE: verify failed (HTTP ${status}): ${JSON.stringify(json).slice(0, 400)}. ${buyHint()}`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `SQLGUARD_REQUIRE: verify unreachable (${msg}). ${buyHint()}`;
  }
}
