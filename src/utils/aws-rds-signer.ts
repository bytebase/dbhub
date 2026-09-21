import { isDriverNotInstalled } from "./module-loader.js";

export interface RdsAuthTokenParams {
  hostname: string;
  port: number;
  username: string;
  region: string;
  profile?: string;
}

/**
 * Generate an AWS RDS IAM auth token for database authentication.
 * Uses the named shared-config profile when provided; otherwise the AWS SDK
 * default credential provider chain.
 *
 * Both providers are created with `ignoreCache: true`. The SDK caches the
 * contents of `~/.aws/credentials` and `~/.aws/config` in a module-level map
 * for the lifetime of the process, so a long-running DBHub would otherwise keep
 * signing with the credentials it read at startup and never notice that the
 * files were rotated externally (e.g. refreshed STS credentials). Tokens are
 * regenerated every ~14 minutes, so the extra file read is negligible.
 */
export async function generateRdsAuthToken(params: RdsAuthTokenParams): Promise<string> {
  let Signer: typeof import("@aws-sdk/rds-signer")["Signer"];
  try {
    ({ Signer } = await import("@aws-sdk/rds-signer"));
  } catch (error) {
    if (isDriverNotInstalled(error, "@aws-sdk/rds-signer")) {
      throw new Error(
        'AWS IAM authentication requires the "@aws-sdk/rds-signer" package. Install it with: pnpm add @aws-sdk/rds-signer'
      );
    }
    throw error;
  }

  const signerConfig: ConstructorParameters<typeof Signer>[0] = {
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    region: params.region,
  };

  const { fromIni, fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
  signerConfig.credentials = params.profile
    ? fromIni({ profile: params.profile, ignoreCache: true })
    : fromNodeProviderChain({ ignoreCache: true });

  const signer = new Signer(signerConfig);

  return signer.getAuthToken();
}
