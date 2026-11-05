/**
 * Resolusi konfigurasi CLI `sk` (Fase 14D).
 *
 * API key TIDAK PERNAH diterima lewat flag baris perintah (akan bocor
 * ke riwayat shell & daftar proses) — sumbernya hanya:
 *
 *   1. env `SK_API_KEY`                        (menang atas berkas)
 *   2. berkas konfigurasi JSON:
 *      `$XDG_CONFIG_HOME/sahabat-kreator/config.json`, atau
 *      `~/.config/sahabat-kreator/config.json` bila XDG tak ter-set:
 *      `{ "baseUrl": "https://...", "apiKey": "sk_live_..." }`
 *
 * Base URL berjenjang:
 *   flag --base-url  >  env `SK_BASE_URL`  >  berkas konfigurasi  >
 *   bawaan `https://botara.my.id` (bawaan yang sama dengan server MCP;
 *   SDK sendiri memang mewajibkan baseUrl eksplisit dari pemanggil).
 *
 * Kunci tidak pernah dicetak utuh: yang ditampilkan hanya sidik jari
 * tersamar (`sk_live_…` + 4 karakter terakhir).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "./args.js";

export const DEFAULT_BASE_URL = "https://botara.my.id";

export interface FileConfig {
  baseUrl?: string;
  apiKey?: string;
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(homedir(), ".config");
  return path.join(base, "sahabat-kreator", "config.json");
}

export function loadFileConfig(
  env: NodeJS.ProcessEnv = process.env,
): FileConfig | null {
  const file = configFilePath(env);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // berkas tidak ada = memang tidak dikonfigurasi
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`config file ${file} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`config file ${file} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const out: FileConfig = {};
  if (obj.baseUrl !== undefined) {
    if (typeof obj.baseUrl !== "string" || obj.baseUrl.trim() === "") {
      throw new UsageError(`config file ${file}: "baseUrl" must be a string`);
    }
    out.baseUrl = obj.baseUrl;
  }
  if (obj.apiKey !== undefined) {
    if (typeof obj.apiKey !== "string" || obj.apiKey.trim() === "") {
      throw new UsageError(`config file ${file}: "apiKey" must be a string`);
    }
    out.apiKey = obj.apiKey;
  }
  return out;
}

export interface ResolvedConfig {
  baseUrl: string;
  baseUrlSource: "--base-url" | "SK_BASE_URL" | "config file" | "default";
  apiKey: string | null;
  apiKeySource: "SK_API_KEY" | "config file" | null;
}

export function resolveConfig(
  flagBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const file = loadFileConfig(env);

  let baseUrl = DEFAULT_BASE_URL;
  let baseUrlSource: ResolvedConfig["baseUrlSource"] = "default";
  if (file?.baseUrl) {
    baseUrl = file.baseUrl;
    baseUrlSource = "config file";
  }
  const envBase = env.SK_BASE_URL;
  if (envBase && envBase.trim() !== "") {
    baseUrl = envBase;
    baseUrlSource = "SK_BASE_URL";
  }
  if (flagBaseUrl !== undefined) {
    baseUrl = flagBaseUrl;
    baseUrlSource = "--base-url";
  }

  let apiKey: string | null = null;
  let apiKeySource: ResolvedConfig["apiKeySource"] = null;
  if (file?.apiKey) {
    apiKey = file.apiKey;
    apiKeySource = "config file";
  }
  const envKey = env.SK_API_KEY;
  if (envKey && envKey.trim() !== "") {
    apiKey = envKey;
    apiKeySource = "SK_API_KEY";
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    baseUrlSource,
    apiKey,
    apiKeySource,
  };
}

/** Sidik jari tersamar: awalan format + 4 karakter terakhir saja. */
export function maskApiKey(apiKey: string): string {
  const tail = apiKey.slice(-4);
  if (apiKey.startsWith("sk_live_")) return `sk_live_…${tail}`;
  if (apiKey.length <= 8) return "…";
  return `${apiKey.slice(0, 4)}…${tail}`;
}

export function missingKeyMessage(): string {
  return [
    "No API key configured.",
    "Set the SK_API_KEY environment variable, or create the config file:",
    `  ${configFilePath()}`,
    'with content: { "apiKey": "sk_live_..." }',
    "Create a key in the dashboard: Settings → API Keys.",
  ].join("\n");
}
