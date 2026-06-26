import { describe, it, expect } from 'vitest';
import { buildNativeSshArgs } from '../native-ssh-tunnel.js';
import type { SSHTunnelEstablishRequest } from '../../types/ssh.js';

describe('buildNativeSshArgs', () => {
  const baseRequest: SSHTunnelEstablishRequest = {
    hostAlias: 'mybastion',
    sshConfigPath: '/home/user/.ssh/config',
    targetHost: 'db.internal',
    targetPort: 5432,
  };

  it('should include port forward and host alias', () => {
    const args = buildNativeSshArgs(baseRequest, 15432);

    expect(args).toContain('-N');
    expect(args).toContain('-F');
    expect(args).toContain('/home/user/.ssh/config');
    expect(args).toContain('127.0.0.1:15432:db.internal:5432');
    expect(args[args.length - 1]).toBe('mybastion');
  });

  it('should include overrides when provided', () => {
    const args = buildNativeSshArgs(
      {
        ...baseRequest,
        overrides: {
          user: 'ubuntu',
          port: 2222,
          privateKey: '/home/user/.ssh/id_rsa',
          keepaliveInterval: 60,
          keepaliveCountMax: 5,
        },
      },
      15432
    );

    expect(args).toContain('-l');
    expect(args).toContain('ubuntu');
    expect(args).toContain('-p');
    expect(args).toContain('2222');
    expect(args).toContain('-i');
    expect(args).toContain('/home/user/.ssh/id_rsa');
    expect(args).toContain('ServerAliveInterval=60');
    expect(args).toContain('ServerAliveCountMax=5');
  });

  it('should require hostAlias and sshConfigPath', () => {
    expect(() => buildNativeSshArgs({ ...baseRequest, hostAlias: undefined }, 1)).toThrow(
      'hostAlias'
    );
    expect(() => buildNativeSshArgs({ ...baseRequest, sshConfigPath: undefined }, 1)).toThrow(
      'sshConfigPath'
    );
  });
});
