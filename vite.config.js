const defineConfig = (config) => config;
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Every build gets an isolated offline cache, including changes to its assets.
export default defineConfig({
  plugins: [{
    name: 'version-offline-shell',
    async closeBundle() {
      const directory = resolve('dist');
      const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((file) => file.isFile())
        .map((file) => resolve(file.parentPath, file.name)).sort();
      const hash = createHash('sha256');
      for (const file of files) hash.update(await readFile(file));
      const workerPath = resolve(directory, 'sw.js');
      const worker = await readFile(workerPath, 'utf8');
      await writeFile(workerPath, worker.replace("const CACHE = 'boveda-plus-v1';", `const CACHE = 'boveda-plus-v1-${hash.digest('hex').slice(0, 16)}';`));
    },
  }],
});
