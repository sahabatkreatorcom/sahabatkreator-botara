#!/usr/bin/env node
/**
 * CLI `sk` — Sahabat Kreator (Fase 14D, RANCANGAN §2 janji arsitektur
 * v3: API, worker, CLI, MCP, realtime adalah adapter tipis di atas
 * core yang sama; di sini adapter-nya adalah SDK publik).
 *
 *   sk <perintah> [argumen] [flag]
 *
 * Setiap perintah memanggil API publik v1 lewat @sahabat-kreator/sdk —
 * TIDAK ada klien HTTP kedua yang ditulis tangan di sini. Pemetaan
 * perintah ↔ rute ↔ metode SDK dijaga registry PUBLIC_V1_SURFACE dan
 * `pnpm check:drift`.
 *
 * Konfigurasi: env SK_API_KEY, atau berkas
 * ~/.config/sahabat-kreator/config.json — lihat `sk --help`.
 * Kode keluar: 0 sukses; 1 error API/jaringan (kode kontrak API
 * ditampilkan); 2 kesalahan pemakaian/konfigurasi.
 */
import {
  SahabatKreatorApiError,
  SahabatKreatorClient,
} from "@sahabat-kreator/sdk";
import { parseArgs, UsageError, type FlagSpec } from "./args.js";
import { COMMANDS, type CommandDef } from "./commands.js";
import {
  configFilePath,
  missingKeyMessage,
  resolveConfig,
} from "./config.js";
import { renderResult } from "./render.js";

const VERSION = "0.1.0";

const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: "json",
    type: "boolean",
    description: "Print the raw API response as JSON (stable for scripts)",
  },
  {
    name: "base-url",
    type: "string",
    description: "API origin override (wins over SK_BASE_URL and config)",
    valueName: "<url>",
  },
  {
    name: "help",
    type: "boolean",
    description: "Show help for this command",
  },
];

function flagHelpLine(spec: FlagSpec): string {
  const value =
    spec.type === "boolean" ? "" : ` ${spec.valueName ?? "<value>"}`;
  const repeat = spec.repeat ? " (repeatable)" : "";
  const required = spec.required ? " (required)" : "";
  return `  --${spec.name}${value}\n      ${spec.description}${repeat}${required}`;
}

function rootHelp(): string {
  const lines: string[] = [
    `sk — Sahabat Kreator CLI (v${VERSION})`,
    "",
    "Usage: sk <command> [arguments] [flags]",
    "",
    "Commands:",
  ];
  const width = Math.max(...COMMANDS.map((c) => c.cli.length));
  for (const cmd of COMMANDS) {
    lines.push(`  ${cmd.cli.padEnd(width)}  ${cmd.summary}`);
  }
  lines.push(
    "",
    "Global flags (accepted by every command):",
    ...GLOBAL_FLAGS.map(flagHelpLine),
    "",
    "Configuration:",
    "  API key — env SK_API_KEY, or the config file:",
    `    ${configFilePath()}`,
    '    with content: { "baseUrl": "https://botara.my.id", "apiKey": "sk_live_..." }',
    "  Base URL — --base-url > SK_BASE_URL > config file > https://botara.my.id",
    "  Keys are created in the dashboard (Settings → API Keys); the key",
    "  is never accepted as a flag and never printed in full.",
    "",
    "Output: human-readable by default; --json prints the raw API",
    "response and is the stable format for scripts.",
    "Exit codes: 0 ok · 1 API/network error · 2 usage/config error.",
    "",
    "Run `sk <command> --help` for command details.",
  );
  return lines.join("\n");
}

function groupHelp(group: string): string {
  const members = COMMANDS.filter(
    (c) => c.cli === group || c.cli.startsWith(`${group} `),
  );
  const lines = [`sk ${group} — commands:`, ""];
  for (const cmd of members) {
    lines.push(`  ${cmd.cli.padEnd(24)}  ${cmd.summary}`);
  }
  lines.push("", `Run \`sk <command> --help\` for details.`);
  return lines.join("\n");
}

function commandHelp(cmd: CommandDef): string {
  const lines: string[] = [
    `sk ${cmd.usage}`,
    "",
    cmd.summary,
    `API key scope required: ${cmd.scope}`,
  ];
  const allFlags = [...cmd.flags, ...GLOBAL_FLAGS];
  if (allFlags.length > 0) {
    lines.push("", "Flags:", ...allFlags.map(flagHelpLine));
  }
  lines.push("", "Add --json for the raw API response (stable for scripts).");
  return lines.join("\n");
}

function printApiError(err: SahabatKreatorApiError, json: boolean): void {
  if (json) {
    process.stderr.write(
      `${JSON.stringify({
        error: { code: err.code, status: err.status, message: err.message },
      })}\n`,
    );
    return;
  }
  const status = err.status === 0 ? "network" : `HTTP ${err.status}`;
  process.stderr.write(`Error: ${err.code} (${status}) — ${err.message}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(`${rootHelp()}\n`);
    return 0;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`sk ${VERSION}\n`);
    return 0;
  }
  if (args[0] === "help") {
    const rest = args.slice(1);
    if (rest.length === 0) {
      process.stdout.write(`${rootHelp()}\n`);
      return 0;
    }
    const target = COMMANDS.find((c) => c.cli === rest.join(" "));
    if (target) {
      process.stdout.write(`${commandHelp(target)}\n`);
      return 0;
    }
    if (COMMANDS.some((c) => c.cli.startsWith(`${rest[0]} `))) {
      process.stdout.write(`${groupHelp(rest[0])}\n`);
      return 0;
    }
    throw new UsageError(`unknown command "${rest.join(" ")}"`);
  }

  // Perintah terdiri dari satu kata (whoami) atau dua kata (grup +
  // verba). Pencocokan terpanjang menang.
  const twoWords = args.slice(0, 2).join(" ");
  const command =
    COMMANDS.find((c) => c.cli === twoWords) ??
    COMMANDS.find((c) => c.cli === args[0]);
  if (!command) {
    if (COMMANDS.some((c) => c.cli.startsWith(`${args[0]} `))) {
      if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(`${groupHelp(args[0])}\n`);
        return 0;
      }
      process.stdout.write(`${groupHelp(args[0])}\n`);
      return 2;
    }
    throw new UsageError(
      `unknown command "${args.join(" ")}" — run \`sk --help\``,
    );
  }
  const rest = args.slice(command.cli.split(" ").length);

  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return 0;
  }

  const parsed = parseArgs(rest, command.positionals, [
    ...command.flags,
    ...GLOBAL_FLAGS,
  ]);
  if (parsed.getBool("help")) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return 0;
  }

  const config = resolveConfig(parsed.getString("base-url"));
  if (!config.apiKey) {
    process.stderr.write(`${missingKeyMessage()}\n`);
    return 2;
  }

  const client = new SahabatKreatorClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  const json = parsed.getBool("json");
  const result = await command.run(client, parsed, { config, json });
  renderResult(result, json);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof SahabatKreatorApiError) {
      // --json mungkin ada di argv walau parsing gagal di tengah; cek
      // kasar di sini cukup untuk jalur error.
      printApiError(err, process.argv.includes("--json"));
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
