#!/usr/bin/env node
// Shim bin `sk`: titik masuk yang didaftarkan package.json ("bin").
// Implementasi sebenarnya adalah bundle tsup di ../dist/index.js —
// jalankan `pnpm --filter @sahabat-kreator/cli build` lebih dulu.
import "../dist/index.js";
