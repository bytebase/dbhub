export type DatabaseType = 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite';

export interface SSHTunnel {
  enabled: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
}

export interface DataSource {
  id: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  is_default: boolean;
  readonly?: boolean;
  max_rows?: number | null;
  ssh_tunnel?: SSHTunnel;
}
