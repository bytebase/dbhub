import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveTunnelPlan } from '../ssh-tunnel-resolver.js';
import type { SourceConfig } from '../../types/config.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function baseSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'test',
    type: 'postgres',
    dsn: 'postgres://user:pass@10.100.100.100:5432/mydb',
    ssh_host: 'mtn03',
    ...overrides,
  };
}

describe('resolveTunnelPlan', () => {
  let tempDir: string;
  let configPath: string;
  let originalForceSsh2: string | undefined;
  let originalSshConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dbhub-tunnel-resolver-'));
    configPath = join(tempDir, 'config');
    originalForceSsh2 = process.env.DBHUB_SSH_FORCE_SSH2;
    originalSshConfig = process.env.DBHUB_SSH_CONFIG;
    delete process.env.DBHUB_SSH_FORCE_SSH2;
    process.env.DBHUB_SSH_CONFIG = configPath;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalForceSsh2 === undefined) {
      delete process.env.DBHUB_SSH_FORCE_SSH2;
    } else {
      process.env.DBHUB_SSH_FORCE_SSH2 = originalForceSsh2;
    }
    if (originalSshConfig === undefined) {
      delete process.env.DBHUB_SSH_CONFIG;
    } else {
      process.env.DBHUB_SSH_CONFIG = originalSshConfig;
    }
  });

  it('should choose native mode when alias exists in SSH config', () => {
    writeFileSync(
      configPath,
      `
Host mtn03
    HostName 10.100.100.100
    User bigdatauser
    ProxyJump jumpbox
`
    );

    const plan = resolveTunnelPlan(baseSource());

    expect(plan.mode).toBe('native');
    expect(plan.hostAlias).toBe('mtn03');
    expect(plan.sshConfigPath).toBe(configPath);
    expect(plan.reason).toContain("alias 'mtn03'");
  });

  it('should choose ssh2 when ssh_password is set', () => {
    writeFileSync(
      configPath,
      `
Host mtn03
    HostName 10.100.100.100
    User bigdatauser
`
    );

    const plan = resolveTunnelPlan(
      baseSource({ ssh_password: 'secret', ssh_user: 'bigdatauser' })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.sshConfig?.host).toBe('10.100.100.100');
    expect(plan.reason).toContain('ssh_password');
  });

  it('should choose ssh2 when ssh_proxy_jump is set', () => {
    writeFileSync(
      configPath,
      `
Host mtn03
    HostName 10.100.100.100
    User bigdatauser
    ProxyJump jumpbox
`
    );

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_proxy_jump: 'ubuntu@18.1.2.3',
        ssh_user: 'bigdatauser',
        ssh_key: '/home/user/.ssh/id_rsa',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.sshConfig?.proxyJump).toBe('ubuntu@18.1.2.3');
    expect(plan.reason).toContain('ssh_proxy_jump');
  });

  it('should choose ssh2 for direct IP hosts', () => {
    const plan = resolveTunnelPlan(
      baseSource({
        ssh_host: '18.1.2.3',
        ssh_user: 'ubuntu',
        ssh_key: '/home/user/.ssh/id_rsa',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.sshConfig?.host).toBe('18.1.2.3');
  });

  it('should choose ssh2 when alias is not found in SSH config', () => {
    writeFileSync(configPath, '');

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_host: 'unknown-alias',
        ssh_user: 'ubuntu',
        ssh_key: '/home/user/.ssh/id_rsa',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.reason).toContain("not found");
  });

  it('should force ssh2 when DBHUB_SSH_FORCE_SSH2 is set', () => {
    writeFileSync(
      configPath,
      `
Host mtn03
    HostName 10.100.100.100
    User bigdatauser
`
    );
    process.env.DBHUB_SSH_FORCE_SSH2 = '1';

    const plan = resolveTunnelPlan(baseSource());

    expect(plan.mode).toBe('ssh2');
    expect(plan.reason).toContain('DBHUB_SSH_FORCE_SSH2');
  });

  it('should pass TOML overrides for native mode', () => {
    writeFileSync(
      configPath,
      `
Host mtn03
    HostName 10.100.100.100
    User bigdatauser
`
    );

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_user: 'override-user',
        ssh_port: 2222,
        ssh_key: '/custom/key',
        ssh_keepalive_interval: 60,
      })
    );

    expect(plan.mode).toBe('native');
    expect(plan.overrides).toEqual({
      user: 'override-user',
      port: 2222,
      privateKey: '/custom/key',
      keepaliveInterval: 60,
    });
  });
});
