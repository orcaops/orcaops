#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await rm(path.join(packageRoot, 'dist'), { recursive: true, force: true });
