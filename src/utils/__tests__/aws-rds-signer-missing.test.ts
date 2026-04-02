import { describe, it, expect } from 'vitest';
import { isDriverNotInstalled } from '../module-loader.js';

describe('isDriverNotInstalled with scoped packages', () => {
  it('should match ERR_MODULE_NOT_FOUND for @aws-sdk/rds-signer', () => {
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
