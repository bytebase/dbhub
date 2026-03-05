import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateRdsAuthToken } from '../aws-rds-signer.js';

const signerMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  getAuthToken: vi.fn(),
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

describe('generateRdsAuthToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create signer with expected params and return token', async () => {
    signerMocks.getAuthToken.mockResolvedValue('iam-token');

    const token = await generateRdsAuthToken({
      hostname: 'mydb.abc123.eu-west-1.rds.amazonaws.com',
      port: 3306,
      username: 'dbuser@example.com',
      region: 'eu-west-1',
    });

    expect(signerMocks.constructor).toHaveBeenCalledWith({
      hostname: 'mydb.abc123.eu-west-1.rds.amazonaws.com',
      port: 3306,
      username: 'dbuser@example.com',
      region: 'eu-west-1',
    });
    expect(signerMocks.getAuthToken).toHaveBeenCalledTimes(1);
    expect(token).toBe('iam-token');
  });

  it('should propagate SDK signer errors', async () => {
    signerMocks.getAuthToken.mockRejectedValue(
      new Error('AWS credentials not found')
    );

    await expect(
      generateRdsAuthToken({
        hostname: 'mydb.abc123.eu-west-1.rds.amazonaws.com',
        port: 5432,
        username: 'db_user',
        region: 'eu-west-1',
      })
    ).rejects.toThrow('AWS credentials not found');
  });
});
