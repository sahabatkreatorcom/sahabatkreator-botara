/**
 * Parser argumen CLI `sk` — ditulis tangan, kecil, dan KETAT.
 *
 * Keputusan Fase 14D: tidak ada library parser yang layak di pohon
 * dependensi workspace (commander@4 hanya dependensi transitif tua
 * milik sucrase — perangkat build, bukan runtime; yargs@15 serupa).
 * Menarik library baru hanya untuk ±35 perintah berarti dependensi
 * runtime tambahan pada artefak klien yang sengaja dibuat ramping,
 * jadi parser ini ditulis tangan dengan perilaku yang disengaja
 * sempit dan mudah ditebak:
 *
 * - Flag string/number: `--nama nilai` atau `--nama=nilai`.
 * - Flag boolean: hanya bentuk telanjang `--json` (tanpa nilai).
 * - Flag `repeat` menumpuk menjadi daftar (`--tag a --tag b`).
 * - Segala yang tidak dikenal DITOLAK (UsageError): flag asing,
 *   nilai hilang, posisi berlebih, angka bukan bilangan bulat.
 *   CLI yang menelan diam-diam adalah CLI yang menyesatkan skrip.
 * - `--` menghentikan parsing flag; sisanya adalah posisi.
 */

export interface FlagSpec {
  name: string;
  type: "string" | "number" | "boolean";
  repeat?: boolean;
  required?: boolean;
  description: string;
  /** Nama nilai untuk teks bantuan, mis. "<teks>". */
  valueName?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class ParsedArgs {
  constructor(
    readonly positionals: Readonly<Record<string, string>>,
    private readonly values: ReadonlyMap<string, string | number | boolean | string[]>,
  ) {}

  getString(name: string): string | undefined {
    const v = this.values.get(name);
    return typeof v === "string" ? v : undefined;
  }

  getNumber(name: string): number | undefined {
    const v = this.values.get(name);
    return typeof v === "number" ? v : undefined;
  }

  getBool(name: string): boolean {
    return this.values.get(name) === true;
  }

  getList(name: string): string[] {
    const v = this.values.get(name);
    return Array.isArray(v) ? v : [];
  }

  has(name: string): boolean {
    return this.values.has(name);
  }
}

export function parseArgs(
  argv: readonly string[],
  positionalNames: readonly string[],
  flagSpecs: readonly FlagSpec[],
): ParsedArgs {
  const specByName = new Map(flagSpecs.map((s) => [s.name, s]));
  const values = new Map<string, string | number | boolean | string[]>();
  const positionalValues: string[] = [];
  let flagsDone = false;

  const pushValue = (spec: FlagSpec, raw: string): void => {
    if (spec.type === "number") {
      if (!/^-?\d+$/.test(raw)) {
        throw new UsageError(
          `--${spec.name} expects an integer, got "${raw}"`,
        );
      }
      values.set(spec.name, Number(raw));
      return;
    }
    if (spec.repeat) {
      const list = values.get(spec.name);
      if (Array.isArray(list)) list.push(raw);
      else values.set(spec.name, [raw]);
      return;
    }
    values.set(spec.name, raw);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!flagsDone && token === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const spec = specByName.get(name);
      if (!spec) {
        throw new UsageError(`unknown flag --${name}`);
      }
      if (spec.type === "boolean") {
        if (eq !== -1) {
          throw new UsageError(`--${name} does not take a value`);
        }
        values.set(name, true);
        continue;
      }
      let raw: string;
      if (eq !== -1) {
        raw = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new UsageError(`--${name} requires a value`);
        }
        raw = next;
        i += 1;
      }
      if (raw === "") {
        throw new UsageError(`--${name} requires a non-empty value`);
      }
      pushValue(spec, raw);
      continue;
    }
    if (!flagsDone && token.startsWith("-") && token !== "-") {
      throw new UsageError(
        `unknown flag ${token} (short flags are not supported; use --help)`,
      );
    }
    positionalValues.push(token);
  }

  if (positionalValues.length > positionalNames.length) {
    throw new UsageError(
      `unexpected argument "${positionalValues[positionalNames.length]}"`,
    );
  }
  const positionals: Record<string, string> = {};
  positionalNames.forEach((name, idx) => {
    const value = positionalValues[idx];
    if (value === undefined) {
      throw new UsageError(`missing argument <${name}>`);
    }
    positionals[name] = value;
  });

  for (const spec of flagSpecs) {
    if (spec.required && !values.has(spec.name)) {
      throw new UsageError(`--${spec.name} is required`);
    }
  }

  return new ParsedArgs(positionals, values);
}
