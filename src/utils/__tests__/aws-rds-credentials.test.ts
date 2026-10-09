import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateRdsAuthToken } from "../aws-rds-signer.js";

// Real AWS SDK against isolated, fake credential files; no network access.
let dir: string;
let credentials: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dbhub-aws-"));
  credentials = join(dir, "credentials");
  vi.stubEnv("AWS_CONFIG_FILE", join(dir, "config"));
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentials);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function accessKeyFor(profile: string): Promise<string> {
  const token = await generateRdsAuthToken({
    hostname: "offline.invalid", port: 5432, username: "test", region: "us-east-1", profile,
  });
  return new URL(`https://${token}`).searchParams.get("X-Amz-Credential")!.split("/")[0];
}

it("re-reads a rotated shared credentials file", async () => {
  await writeFile(join(dir, "config"), "");
  for (const key of ["FILEKEY1", "FILEKEY2"]) {
    await writeFile(credentials, `[default]\naws_access_key_id = ${key}\naws_secret_access_key = fake\n`);
    expect(await accessKeyFor("default")).toBe(key);
  }
});

it("retries a credential_process that failed until login completed", async () => {
  const helper = join(dir, "helper.cjs");
  const marker = join(dir, "logged-in");
  await writeFile(helper, `
    if (!require("node:fs").existsSync(${JSON.stringify(marker)})) { console.error("Login required"); process.exit(1); }
    console.log(JSON.stringify({ Version: 1, AccessKeyId: "PROCESSKEY", SecretAccessKey: "fake" }));
  `);
  await writeFile(join(dir, "config"), `[profile process]\ncredential_process = "${process.execPath}" "${helper}"\n`);
  await writeFile(credentials, "");

  await expect(accessKeyFor("process")).rejects.toThrow(/Login required/);
  await writeFile(marker, "");
  expect(await accessKeyFor("process")).toBe("PROCESSKEY");
});
