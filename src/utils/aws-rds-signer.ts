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
 * uses its default credential provider chain.
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

  if (params.profile) {
    const { fromIni } = await import("@aws-sdk/credential-providers");
    signerConfig.credentials = fromIni({ profile: params.profile });
  }

  const signer = new Signer(signerConfig);

  return signer.getAuthToken();
}
