import { isDriverNotInstalled } from "./module-loader.js";

export interface RdsAuthTokenParams {
  hostname: string;
  port: number;
  username: string;
  region: string;
}

/**
 * Generate an AWS RDS IAM auth token for database authentication.
 * The AWS SDK uses the default credential provider chain
 * (AWS CLI profile, env vars, instance role, etc.).
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

  const signer = new Signer({
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    region: params.region,
  });

  return signer.getAuthToken();
}
