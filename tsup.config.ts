import { defineConfig } from 'tsup';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // Database drivers are optionalDependencies loaded at runtime via dynamic
  // import(). They must be external so tsup does not bundle their CJS code
  // into ESM chunks (which causes "Dynamic require of X is not supported").
  external: ['pg', 'mysql2', 'mariadb', 'mssql', 'better-sqlite3', '@aws-sdk/rds-signer', '@azure/identity'],
  // Copy the employee-sqlite demo data to dist
  async onSuccess() {
    // Create target directory
    const targetDir = path.join('dist', 'demo', 'employee-sqlite');
    fs.mkdirSync(targetDir, { recursive: true });

    // Copy all SQL files from demo/employee-sqlite to dist/demo/employee-sqlite
    const sourceDir = path.join('demo', 'employee-sqlite');
    const files = fs.readdirSync(sourceDir);

    for (const file of files) {
      if (file.endsWith('.sql')) {
        const sourcePath = path.join(sourceDir, file);
        const targetPath = path.join(targetDir, file);
        fs.copyFileSync(sourcePath, targetPath);
        console.log(`Copied ${sourcePath} to ${targetPath}`);
      }
    }
  },
});
