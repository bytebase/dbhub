import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("re-reads credentials and retries credential_process without falling back from an explicit profile", async () => {
  // Run the real SDK with an isolated HOME/environment: no developer AWS files,
  // browser, metadata service, or remote API. Every credential below is fake.
  const dir = await mkdtemp(join(tmpdir(), "dbhub-aws-"));
  const config = join(dir, "config");
  const credentials = join(dir, "credentials");
  const helper = join(dir, "credentials.cjs");
  const marker = join(dir, "authenticated");
  const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  try {
    await writeFile(helper, `
      if (!require('node:fs').existsSync(${JSON.stringify(marker)})) {
        console.error('Login required'); process.exit(1);
      }
      console.log(JSON.stringify({ Version: 1, AccessKeyId: 'PROCESSKEY',
        SecretAccessKey: 'fake-secret', SessionToken: 'fake-session',
        Expiration: new Date(Date.now() + 3600000).toISOString() }));
    `);
    await writeFile(config, `[profile process]\ncredential_process = ${shellQuote(process.execPath)} ${shellQuote(helper)}\n`);
    await writeFile(credentials, "");
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { writeFile } from 'node:fs/promises';
        import { generateRdsAuthToken } from './src/utils/aws-rds-signer.ts';
        const params = { hostname: 'offline.invalid', port: 5432, username: 'test', region: 'us-east-1' };
        const identity = async (profile) => {
          const token = await generateRdsAuthToken({ ...params, profile });
          return new URL('https://' + token).searchParams.get('X-Amz-Credential').split('/')[0];
        };
        process.env.AWS_ACCESS_KEY_ID = 'ENVKEY';
        process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret';
        assert.equal(await identity(), 'ENVKEY');
        await assert.rejects(identity('missing'), /Could not resolve credentials/);
        await assert.rejects(identity('process'), /Login required/);
        await writeFile(${JSON.stringify(marker)}, 'yes');
        assert.equal(await identity('process'), 'PROCESSKEY');
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        for (const key of ['FILEKEY1', 'FILEKEY2']) {
          await writeFile(process.env.AWS_SHARED_CREDENTIALS_FILE,
            '[default]\\naws_access_key_id = ' + key + '\\naws_secret_access_key = fake-secret\\n');
          assert.equal(await identity(), key);
          assert.equal(await identity('default'), key);
        }
        console.log('PASS: environment, explicit profile isolation, credential_process recovery, replaced shared credentials');
      `,
    ], {
      timeout: 10000,
      env: { PATH: process.env.PATH, HOME: dir,
        AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials,
        AWS_EC2_METADATA_DISABLED: "true" },
    });
    expect(stdout).toContain("PASS:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
