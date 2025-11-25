import { defineConfig } from 'tsup';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
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
