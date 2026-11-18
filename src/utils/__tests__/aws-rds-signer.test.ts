import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateRdsAuthToken } from '../aws-rds-signer.js';

const signerMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  getAuthToken: vi.fn(),
}));
const credentialProviderMocks = vi.hoisted(() => ({
  fromIni: vi.fn(),
  fromNodeProviderChain: vi.fn(),
}));

vi.mock('@aws-sdk/rds-signer', () => {
  class MockSigner {
    constructor(config: unknown) {
      signerMocks.constructor(config);
    }

    getAuthToken() {
      return signerMocks.getAuthToken();
    }
  }

  return { Signer: MockSigner };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: credentialProviderMocks.fromIni,
  fromNodeProviderChain: credentialProviderMocks.fromNodeProviderChain,
}));

describe('generateRdsAuthToken', () => {
  const target = {
    hostname: 'mydb.abc123.us-east-1.rds.amazonaws.com',
    port: 5432,
    username: 'db_user',
    region: 'us-east-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    signerMocks.getAuthToken.mockResolvedValue('iam-token');
  });

  it('should resolve an explicit profile without credential fallback', async () => {
    const profileCredentials = vi.fn();
    credentialProviderMocks.fromIni.mockReturnValue(profileCredentials);

    await generateRdsAuthToken({ ...target, profile: 'ngqa' });

    expect(credentialProviderMocks.fromIni).toHaveBeenCalledWith({ profile: 'ngqa', ignoreCache: true });
    expect(credentialProviderMocks.fromNodeProviderChain).not.toHaveBeenCalled();
    expect(signerMocks.constructor).toHaveBeenCalledWith({ ...target, credentials: profileCredentials });
  });

  it('should use the default provider chain with the file cache disabled when no profile is set', async () => {
    const chainCredentials = vi.fn();
    credentialProviderMocks.fromNodeProviderChain.mockReturnValue(chainCredentials);

    const token = await generateRdsAuthToken(target);

    expect(credentialProviderMocks.fromNodeProviderChain).toHaveBeenCalledWith({ ignoreCache: true });
    expect(credentialProviderMocks.fromIni).not.toHaveBeenCalled();
    expect(signerMocks.constructor).toHaveBeenCalledWith({ ...target, credentials: chainCredentials });
    expect(signerMocks.getAuthToken).toHaveBeenCalledTimes(1);
    expect(token).toBe('iam-token');
  });
});
