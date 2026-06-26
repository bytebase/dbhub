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
    dsn: 'postgres://user:pass@10.0.0.5:5432/mydb',
    ssh_host: 'target-with-jump',
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
Host target-with-jump
    HostName 10.0.0.5
    User admin
    ProxyJump mybastion
`
    );

    const plan = resolveTunnelPlan(baseSource());

    expect(plan.mode).toBe('native');
    expect(plan.hostAlias).toBe('target-with-jump');
    expect(plan.sshConfigPath).toBe(configPath);
    expect(plan.reason).toContain("alias 'target-with-jump'");
  });

  it('should choose ssh2 when ssh_password is set', () => {
    writeFileSync(
      configPath,
      `
Host mybastion
    HostName bastion.example.com
    User ubuntu
`
    );

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_host: 'mybastion',
        ssh_password: 'secret',
        ssh_user: 'ubuntu',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.sshConfig?.host).toBe('bastion.example.com');
    expect(plan.reason).toContain('ssh_password');
  });

  it('should choose ssh2 when ssh_proxy_jump is set', () => {
    writeFileSync(
      configPath,
      `
Host target-with-jump
    HostName 10.0.0.5
    User admin
    ProxyJump mybastion
`
    );

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_proxy_jump: 'bastion.example.com',
        ssh_user: 'admin',
        ssh_key: '/home/user/.ssh/id_rsa',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.sshConfig?.proxyJump).toBe('bastion.example.com');
    expect(plan.reason).toContain('ssh_proxy_jump');
  });

  it('should choose ssh2 for direct hostnames', () => {
    const plan = resolveTunnelPlan(
      baseSource({
        ssh_host: 'bastion.example.com',
        ssh_user: 'ubuntu',
        ssh_key: '/home/user/.ssh/id_rsa',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.sshConfig?.host).toBe('bastion.example.com');
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
    expect(plan.reason).toContain('not found');
  });

  it('should force ssh2 when DBHUB_SSH_FORCE_SSH2 is set', () => {
    writeFileSync(
      configPath,
      `
Host mybastion
    HostName bastion.example.com
    User ubuntu
`
    );
    process.env.DBHUB_SSH_FORCE_SSH2 = '1';

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_host: 'mybastion',
        dsn: 'postgres://user:pass@db.internal:5432/mydb',
      })
    );

    expect(plan.mode).toBe('ssh2');
    expect(plan.reason).toContain('DBHUB_SSH_FORCE_SSH2');
  });

  it('should pass TOML overrides for native mode', () => {
    writeFileSync(
      configPath,
      `
Host mybastion
    HostName bastion.example.com
    User ubuntu
`
    );

    const plan = resolveTunnelPlan(
      baseSource({
        ssh_host: 'mybastion',
        dsn: 'postgres://user:pass@db.internal:5432/mydb',
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
