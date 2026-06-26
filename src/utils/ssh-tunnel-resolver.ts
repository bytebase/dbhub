import type { SourceConfig } from '../types/config.js';
import type { ResolvedTunnelPlan, NativeSSHOverrides, SSHTunnelConfig } from '../types/ssh.js';
import {
  parseSSHConfig,
  looksLikeSSHAlias,
  getDefaultSSHConfigPath,
} from './ssh-config-parser.js';

function getSSHConfigPath(): string {
  return process.env.DBHUB_SSH_CONFIG ?? getDefaultSSHConfigPath();
}

function isForceSsh2(): boolean {
  const value = process.env.DBHUB_SSH_FORCE_SSH2;
  return value === '1' || value?.toLowerCase() === 'true';
}

function buildOverrides(source: SourceConfig): NativeSSHOverrides | undefined {
  const overrides: NativeSSHOverrides = {};
  let hasOverride = false;

  if (source.ssh_user) {
    overrides.user = source.ssh_user;
    hasOverride = true;
  }
  if (source.ssh_port !== undefined) {
    overrides.port = source.ssh_port;
    hasOverride = true;
  }
  if (source.ssh_key) {
    overrides.privateKey = source.ssh_key;
    hasOverride = true;
  }
  if (source.ssh_keepalive_interval !== undefined) {
    overrides.keepaliveInterval = source.ssh_keepalive_interval;
    hasOverride = true;
  }
  if (source.ssh_keepalive_count_max !== undefined) {
    overrides.keepaliveCountMax = source.ssh_keepalive_count_max;
    hasOverride = true;
  }

  return hasOverride ? overrides : undefined;
}

function buildSsh2Config(
  source: SourceConfig,
  resolvedSSHConfig: SSHTunnelConfig | null
): SSHTunnelConfig {
  const username = source.ssh_user || resolvedSSHConfig?.username;

  return {
    host: resolvedSSHConfig?.host || source.ssh_host!,
    port: source.ssh_port || resolvedSSHConfig?.port || 22,
    username: username || '',
    password: source.ssh_password,
    privateKey: source.ssh_key || resolvedSSHConfig?.privateKey,
    passphrase: source.ssh_passphrase,
    proxyJump: source.ssh_proxy_jump || resolvedSSHConfig?.proxyJump,
    keepaliveInterval: source.ssh_keepalive_interval,
    keepaliveCountMax: source.ssh_keepalive_count_max,
  };
}

function resolveSSHConfigForHost(host: string, sshConfigPath: string): SSHTunnelConfig | null {
  if (!looksLikeSSHAlias(host)) {
    return null;
  }
  return parseSSHConfig(host, sshConfigPath);
}

/**
 * Decide whether to use native OpenSSH or the built-in ssh2 tunnel.
 */
export function resolveTunnelPlan(source: SourceConfig): ResolvedTunnelPlan {
  const sshConfigPath = getSSHConfigPath();
  const host = source.ssh_host!;

  if (isForceSsh2()) {
    const resolvedSSHConfig = resolveSSHConfigForHost(host, sshConfigPath);
    return {
      mode: 'ssh2',
      sshConfigPath,
      sshConfig: buildSsh2Config(source, resolvedSSHConfig),
      reason: 'DBHUB_SSH_FORCE_SSH2 is set',
    };
  }

  const resolvedSSHConfig = resolveSSHConfigForHost(host, sshConfigPath);
  const useNative =
    resolvedSSHConfig !== null &&
    !source.ssh_password &&
    !source.ssh_proxy_jump;

  if (useNative) {
    return {
      mode: 'native',
      hostAlias: host,
      sshConfigPath,
      overrides: buildOverrides(source),
      reason: `alias '${host}' found in ${sshConfigPath}`,
    };
  }

  let reason = `ssh2 mode for '${host}'`;
  if (resolvedSSHConfig && source.ssh_password) {
    reason = 'ssh2 mode: ssh_password is not supported by native SSH';
  } else if (resolvedSSHConfig && source.ssh_proxy_jump) {
    reason = 'ssh2 mode: explicit ssh_proxy_jump overrides native SSH';
  } else if (!resolvedSSHConfig && looksLikeSSHAlias(host)) {
    reason = `ssh2 mode: alias '${host}' not found in ${sshConfigPath}`;
  }

  return {
    mode: 'ssh2',
    sshConfigPath,
    sshConfig: buildSsh2Config(source, resolvedSSHConfig),
    reason,
  };
}
