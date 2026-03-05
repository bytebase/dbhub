import { Signer } from "@aws-sdk/rds-signer";

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
  const signer = new Signer({
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    region: params.region,
  });

  return signer.getAuthToken();
}
