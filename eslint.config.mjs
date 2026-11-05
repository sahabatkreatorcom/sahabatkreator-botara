import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * ESLint monorepo Sahabat Kreator.
 *
 * Dua aturan yang sengaja jadi ERROR karena keduanya bug nyata:
 *  - `no-undef` dimatikan untuk TS (TS sudah memeriksanya), tetapi
 *  - `no-restricted-syntax` menandai `await` di dalam loop pada jalur
 *    antrean/poller: pola itu membunuh throughput dan mudah jadi N+1.
 *
 * Aturan i18n (`JSXText` berisi teks) masih WARNING, bukan error: kode
 * lama belum sepenuhnya bersih, dan mematikannya jadi error sekarang
 * hanya akan membuat `pnpm lint` merah tanpa ada yang bisa memperbaiki
 * sekaligus. Angka warning-nya jadi metrik utang yang bisa ditekan
 * bertahap sampai layak dijadikan error (RANCANGAN §11.1).
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.d.ts",
      "packages/db/migrations/**",
      // Bundel widget webchat: hasil build minified (dari packages/embed),
      // bukan sumber yang ditulis tangan. Yang di-lint adalah sumbernya.
      "apps/web/public/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly",
        document: "readonly",
        window: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLSelectElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLFormElement: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
      },
    },
    rules: {
      // --- Bug nyata: jangan pernah matikan ---
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ForOfStatement > AwaitExpression, ForInStatement > AwaitExpression, ForStatement > AwaitExpression",
          message:
            "await di dalam loop menyerialkan I/O. Pakai Promise.all / batch, atau pindahkan ke job antrean.",
        },
      ],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "warn",

      // --- Utang yang diukur, bukan dilarang ---
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "no-empty": "warn",
      "no-useless-escape": "warn",
    },
  },
  {
    // JSX memakai parser yang sama, tetapi aturan yang berlaku berbeda:
    // di .tsx yang ditegakkan adalah disiplin i18n (warning, lihat catatan
    // di atas), bukan larangan await-di-loop. Pemisahan ini disengaja —
    // satu nama rule tidak bisa punya dua tingkat keparahan sekaligus.
    files: ["**/*.tsx"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Aturan ini WAJIB terdaftar: kode web memakai
      // `eslint-disable-next-line react-hooks/exhaustive-deps` di beberapa
      // tempat, dan komentar disable untuk rule yang tidak dikenal adalah
      // error — bukan sekadar tidak berefek.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-syntax": [
        "warn",
        {
          selector: "JSXText[value=/[A-Za-z]{2,}/]",
          message:
            "Teks UI harus lewat t('kunci') dari @sahabat-kreator/i18n, bukan literal (RANCANGAN §11.1).",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/scripts/**", "**/*.config.ts", "**/*.config.mjs"],
    rules: {
      "no-restricted-syntax": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
