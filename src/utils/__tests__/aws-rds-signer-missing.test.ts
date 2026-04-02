import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDriverNotInstalled } from '../module-loader.js';

describe('generateRdsAuthToken missing package', () => {
  it('should throw actionable error when @aws-sdk/rds-signer is not installed', async () => {
    // Simulate ERR_MODULE_NOT_FOUND for @aws-sdk/rds-signer
    const err = new Error(
      "Cannot find package '@aws-sdk/rds-signer' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

    expect(isDriverNotInstalled(err, '@aws-sdk/rds-signer')).toBe(true);
  });

  it('should not match unrelated ERR_MODULE_NOT_FOUND errors', () => {
    const err = new Error(
      "Cannot find package 'some-other-pkg' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';

    expect(isDriverNotInstalled(err, '@aws-sdk/rds-signer')).toBe(false);
  });
});
