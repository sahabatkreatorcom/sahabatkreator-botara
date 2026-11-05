/**
 * Tabel perintah CLI `sk` (Fase 14D) — adapter TIPIS di atas
 * @sahabat-kreator/sdk: setiap perintah memanggil tepat satu metode
 * client publik, persis pemetaan yang dicatat registry
 * PUBLIC_V1_SURFACE (@sahabat-kreator/contracts). Tabel inilah yang
 * diperiksa `pnpm check:drift` dua arah terhadap registry: field
 * `cli` + `sdkMethod` yang berurutan di setiap entri adalah pasangan
 * yang dicocokkan — perintah tanpa rute publik (atau rute publik
 * tanpa perintah) membuat penjaga GAGAL.
 *
 * Permukaan TULIS publik memang hanya lima rute (kontak buat/ubah,
 * kirim pesan, sembunyikan/tampilkan komentar) dan TIDAK satu pun
 * bersifat destruktif (tidak ada DELETE di API v1) — karena itu CLI
 * tidak memakai gerbang --yes: tidak ada yang bisa dihapus lewat
 * permukaan ini. Yang disengaja TIDAK dibuat (keputusan matriks):
 * `sk broadcasts send` (pengiriman massal tetap dashboard-only) dan
 * kandidat tanpa rute v1 (`contacts get`, `flows runs`, dst.).
 */
import type { SahabatKreatorClient } from "@sahabat-kreator/sdk";
import type {
  CreateContactRequest,
  ListAppointmentsQuery,
  ListBroadcastsQuery,
  ListCommentsQuery,
  ListContactsQuery,
  ListFlowsQuery,
  OptInStatus,
  UpdateContactRequest,
} from "@sahabat-kreator/contracts";
import { UsageError, type FlagSpec, type ParsedArgs } from "./args.js";
import type { ResolvedConfig } from "./config.js";
import { maskApiKey } from "./config.js";

export interface CommandContext {
  config: ResolvedConfig;
  json: boolean;
}

export interface CommandDef {
  cli: string;
  sdkMethod: string;
  /** Scope API key yang dituntut rute (untuk teks bantuan). */
  scope: string;
  summary: string;
  usage: string;
  positionals: readonly string[];
  flags: readonly FlagSpec[];
  run: (
    client: SahabatKreatorClient,
    args: ParsedArgs,
    ctx: CommandContext,
  ) => Promise<unknown>;
}

const OPT_IN_STATUSES: readonly OptInStatus[] = [
  "unknown",
  "opted_in",
  "opted_out",
];

/** `--field kunci=nilai` (boleh berulang) → objek customFields. */
function customFieldsFromFlags(args: ParsedArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of args.getList("field")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new UsageError(`--field expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

const limitFlag: FlagSpec = {
  name: "limit",
  type: "number",
  description: "Maximum rows to return (API caps apply)",
  valueName: "<n>",
};
const cursorFlag: FlagSpec = {
  name: "cursor",
  type: "string",
  description: "Pagination cursor from a previous page",
  valueName: "<cursor>",
};
const statusFlag: FlagSpec = {
  name: "status",
  type: "string",
  description: "Filter by status",
  valueName: "<status>",
};

export const COMMANDS: readonly CommandDef[] = [
  {
    cli: "whoami",
    sdkMethod: "me",
    scope: "any valid key",
    summary: "Show the tenant, scopes, and endpoint for the configured key",
    usage: "whoami",
    positionals: [],
    flags: [],
    run: async (client, _args, ctx) => {
      const me = await client.me();
      if (ctx.json) return me;
      return {
        baseUrl: ctx.config.baseUrl,
        apiKey: ctx.config.apiKey
          ? `${maskApiKey(ctx.config.apiKey)} (via ${ctx.config.apiKeySource})`
          : "(none)",
        tenant: me.tenantName,
        tenantId: me.tenantId,
        scopes: me.scopes.join(", "),
      };
    },
  },
  {
    cli: "contacts list",
    sdkMethod: "listContacts",
    scope: "contacts:read",
    summary: "List and search contacts",
    usage: "contacts list [--search <text>] [--limit <n>] [--offset <n>]",
    positionals: [],
    flags: [
      {
        name: "search",
        type: "string",
        description: "Search by name, email, or phone",
        valueName: "<text>",
      },
      limitFlag,
      {
        name: "offset",
        type: "number",
        description: "Rows to skip (offset pagination)",
        valueName: "<n>",
      },
    ],
    run: async (client, args) => {
      const query: ListContactsQuery = {
        search: args.getString("search"),
        limit: args.getNumber("limit"),
        offset: args.getNumber("offset"),
      };
      return client.listContacts(query);
    },
  },
  {
    cli: "contacts create",
    sdkMethod: "createContact",
    scope: "contacts:write",
    summary: "Create a contact",
    usage:
      "contacts create --name <name> [--phone <number>] [--email <email>] [--tag <tag>]... [--field <key>=<value>]...",
    positionals: [],
    flags: [
      {
        name: "name",
        type: "string",
        required: true,
        description: "Contact name",
        valueName: "<name>",
      },
      {
        name: "phone",
        type: "string",
        description: "Phone number",
        valueName: "<number>",
      },
      {
        name: "email",
        type: "string",
        description: "Email address",
        valueName: "<email>",
      },
      {
        name: "tag",
        type: "string",
        repeat: true,
        description: "Tag to attach (repeatable)",
        valueName: "<tag>",
      },
      {
        name: "field",
        type: "string",
        repeat: true,
        description: "Custom field as key=value (repeatable)",
        valueName: "<key>=<value>",
      },
    ],
    run: async (client, args) => {
      const tags = args.getList("tag");
      const fields = customFieldsFromFlags(args);
      const input: CreateContactRequest = {
        name: args.getString("name")!,
        phone: args.getString("phone"),
        email: args.getString("email"),
        tags: tags.length > 0 ? tags : undefined,
        customFields: Object.keys(fields).length > 0 ? fields : undefined,
      };
      return client.createContact(input);
    },
  },
  {
    cli: "contacts update",
    sdkMethod: "updateContact",
    scope: "contacts:write",
    summary: "Update a contact (custom fields merge per key)",
    usage:
      "contacts update <id> [--name <name>] [--stage <stage>] [--opt-in-status <status>] [--tag <tag>]... [--field <key>=<value>]...",
    positionals: ["id"],
    flags: [
      {
        name: "name",
        type: "string",
        description: "New name",
        valueName: "<name>",
      },
      {
        name: "stage",
        type: "string",
        description: "Pipeline stage",
        valueName: "<stage>",
      },
      {
        name: "opt-in-status",
        type: "string",
        description: "Stored opt-in status: unknown | opted_in | opted_out",
        valueName: "<status>",
      },
      {
        name: "tag",
        type: "string",
        repeat: true,
        description: "Replace tags with this set (repeatable)",
        valueName: "<tag>",
      },
      {
        name: "field",
        type: "string",
        repeat: true,
        description: "Custom field as key=value, merged per key (repeatable)",
        valueName: "<key>=<value>",
      },
    ],
    run: async (client, args) => {
      const input: UpdateContactRequest = {};
      const name = args.getString("name");
      if (name !== undefined) input.name = name;
      const stage = args.getString("stage");
      if (stage !== undefined) input.pipelineStage = stage;
      const optIn = args.getString("opt-in-status");
      if (optIn !== undefined) {
        if (!OPT_IN_STATUSES.includes(optIn as OptInStatus)) {
          throw new UsageError(
            `--opt-in-status must be one of: ${OPT_IN_STATUSES.join(", ")}`,
          );
        }
        input.optInStatus = optIn as OptInStatus;
      }
      const tags = args.getList("tag");
      if (tags.length > 0) input.tags = tags;
      const fields = customFieldsFromFlags(args);
      if (Object.keys(fields).length > 0) input.customFields = fields;
      if (Object.keys(input).length === 0) {
        throw new UsageError(
          "nothing to update — pass at least one of --name, --stage, --opt-in-status, --tag, --field",
        );
      }
      return client.updateContact(args.positionals.id, input);
    },
  },
  {
    cli: "conversations list",
    sdkMethod: "listConversations",
    scope: "conversations:read",
    summary: "List conversations",
    usage: "conversations list [--status <open|pending|closed>]",
    positionals: [],
    flags: [statusFlag],
    run: async (client, args) => {
      const status = args.getString("status");
      if (
        status !== undefined &&
        !["open", "pending", "closed"].includes(status)
      ) {
        throw new UsageError("--status must be one of: open, pending, closed");
      }
      return client.listConversations({
        status: status as "open" | "pending" | "closed" | undefined,
      });
    },
  },
  {
    cli: "messages list",
    sdkMethod: "listMessages",
    scope: "conversations:read",
    summary: "List messages in a conversation",
    usage: "messages list <conversationId> [--limit <n>]",
    positionals: ["conversationId"],
    flags: [limitFlag],
    run: async (client, args) =>
      client.listMessages(args.positionals.conversationId, {
        limit: args.getNumber("limit"),
      }),
  },
  {
    cli: "messages send",
    sdkMethod: "sendMessage",
    scope: "messages:write",
    summary: "Send an outbound message in a conversation",
    usage: "messages send <conversationId> --text <message>",
    positionals: ["conversationId"],
    flags: [
      {
        name: "text",
        type: "string",
        required: true,
        description: "Message text to send",
        valueName: "<message>",
      },
    ],
    run: async (client, args) =>
      client.sendMessage(args.positionals.conversationId, args.getString("text")!),
  },
  {
    cli: "products list",
    sdkMethod: "listProducts",
    scope: "products:read",
    summary: "List products",
    usage: "products list",
    positionals: [],
    flags: [],
    run: async (client) => client.listProducts(),
  },
  {
    cli: "comments list",
    sdkMethod: "listComments",
    scope: "comments:read",
    summary: "List recorded Instagram/Messenger comments",
    usage:
      "comments list [--channel-account-id <id>] [--automation-id <id>] [--limit <n>]",
    positionals: [],
    flags: [
      {
        name: "channel-account-id",
        type: "string",
        description: "Only comments on this channel account",
        valueName: "<id>",
      },
      {
        name: "automation-id",
        type: "string",
        description: "Only comments touched by this automation",
        valueName: "<id>",
      },
      limitFlag,
    ],
    run: async (client, args) => {
      const query: ListCommentsQuery = {
        channelAccountId: args.getString("channel-account-id"),
        automationId: args.getString("automation-id"),
        limit: args.getNumber("limit"),
      };
      return client.listComments(query);
    },
  },
  {
    cli: "comments hide",
    sdkMethod: "hideComment",
    scope: "comments:write",
    summary: "Hide a comment on Meta",
    usage: "comments hide <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.hideComment(args.positionals.id),
  },
  {
    cli: "comments unhide",
    sdkMethod: "unhideComment",
    scope: "comments:write",
    summary: "Unhide a comment on Meta",
    usage: "comments unhide <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.unhideComment(args.positionals.id),
  },
  {
    cli: "broadcasts list",
    sdkMethod: "listBroadcasts",
    scope: "broadcasts:read",
    summary: "List broadcasts with delivery stats",
    usage: "broadcasts list [--status <status>] [--cursor <cursor>] [--limit <n>]",
    positionals: [],
    flags: [statusFlag, cursorFlag, limitFlag],
    run: async (client, args) => {
      const query: ListBroadcastsQuery = {
        status: args.getString("status") as ListBroadcastsQuery["status"],
        cursor: args.getString("cursor"),
        limit: args.getNumber("limit"),
      };
      return client.listBroadcasts(query);
    },
  },
  {
    cli: "broadcasts get",
    sdkMethod: "getBroadcast",
    scope: "broadcasts:read",
    summary: "Show one broadcast with recipient stats",
    usage: "broadcasts get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getBroadcast(args.positionals.id),
  },
  {
    cli: "flows list",
    sdkMethod: "listFlows",
    scope: "flows:read",
    summary: "List flows (graphs included)",
    usage: "flows list [--status <status>] [--cursor <cursor>] [--limit <n>]",
    positionals: [],
    flags: [statusFlag, cursorFlag, limitFlag],
    run: async (client, args) => {
      const query: ListFlowsQuery = {
        status: args.getString("status") as ListFlowsQuery["status"],
        cursor: args.getString("cursor"),
        limit: args.getNumber("limit"),
      };
      return client.listFlows(query);
    },
  },
  {
    cli: "flows get",
    sdkMethod: "getFlow",
    scope: "flows:read",
    summary: "Show one flow with its full graph",
    usage: "flows get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getFlow(args.positionals.id),
  },
  {
    cli: "flow-templates list",
    sdkMethod: "listFlowTemplates",
    scope: "flows:read",
    summary: "List the flow template catalog",
    usage: "flow-templates list",
    positionals: [],
    flags: [],
    run: async (client) => client.listFlowTemplates(),
  },
  {
    cli: "automations list",
    sdkMethod: "listAutomations",
    scope: "automations:read",
    summary: "List automations (keyword, sequences, comment rules)",
    usage: "automations list",
    positionals: [],
    flags: [],
    run: async (client) => client.listAutomations(),
  },
  {
    cli: "automations get",
    sdkMethod: "getAutomation",
    scope: "automations:read",
    summary: "Show one automation",
    usage: "automations get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getAutomation(args.positionals.id),
  },
  {
    cli: "agents list",
    sdkMethod: "listAgents",
    scope: "agents:read",
    summary: "List AI agent configurations",
    usage: "agents list",
    positionals: [],
    flags: [],
    run: async (client) => client.listAgents(),
  },
  {
    cli: "agents get",
    sdkMethod: "getAgent",
    scope: "agents:read",
    summary: "Show one AI agent configuration",
    usage: "agents get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getAgent(args.positionals.id),
  },
  {
    cli: "channels list",
    sdkMethod: "listChannels",
    scope: "channels:read",
    summary: "List connected channel accounts and health",
    usage: "channels list",
    positionals: [],
    flags: [],
    run: async (client) => client.listChannels(),
  },
  {
    cli: "channels get",
    sdkMethod: "getChannel",
    scope: "channels:read",
    summary: "Show one channel account",
    usage: "channels get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getChannel(args.positionals.id),
  },
  {
    cli: "whatsapp-templates list",
    sdkMethod: "listWhatsAppTemplates",
    scope: "whatsapp_templates:read",
    summary: "List the mirrored WhatsApp templates of one channel account",
    usage: "whatsapp-templates list --channel-account-id <id>",
    positionals: [],
    flags: [
      {
        name: "channel-account-id",
        type: "string",
        required: true,
        description: "WhatsApp channel account id",
        valueName: "<id>",
      },
    ],
    run: async (client, args) =>
      client.listWhatsAppTemplates({
        channelAccountId: args.getString("channel-account-id")!,
      }),
  },
  {
    cli: "kb list",
    sdkMethod: "listKnowledgeDocuments",
    scope: "knowledge:read",
    summary: "List knowledge base entries",
    usage: "kb list",
    positionals: [],
    flags: [],
    run: async (client) => client.listKnowledgeDocuments(),
  },
  {
    cli: "kb get",
    sdkMethod: "getKnowledgeDocument",
    scope: "knowledge:read",
    summary: "Show one knowledge base entry",
    usage: "kb get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) =>
      client.getKnowledgeDocument(args.positionals.id),
  },
  {
    cli: "kb stats",
    sdkMethod: "getKnowledgeStats",
    scope: "knowledge:read",
    summary: "Show knowledge index / semantic search stats",
    usage: "kb stats",
    positionals: [],
    flags: [],
    run: async (client) => client.getKnowledgeStats(),
  },
  {
    cli: "growth-links list",
    sdkMethod: "listGrowthLinks",
    scope: "growth_links:read",
    summary: "List growth links with derived stats",
    usage: "growth-links list",
    positionals: [],
    flags: [],
    run: async (client) => client.listGrowthLinks(),
  },
  {
    cli: "growth-links get",
    sdkMethod: "getGrowthLink",
    scope: "growth_links:read",
    summary: "Show one growth link with stats",
    usage: "growth-links get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getGrowthLink(args.positionals.id),
  },
  {
    cli: "segments list",
    sdkMethod: "listSegments",
    scope: "segments:read",
    summary: "List audience segments",
    usage: "segments list",
    positionals: [],
    flags: [],
    run: async (client) => client.listSegments(),
  },
  {
    cli: "segments get",
    sdkMethod: "getSegment",
    scope: "segments:read",
    summary: "Show one audience segment definition",
    usage: "segments get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getSegment(args.positionals.id),
  },
  {
    cli: "orders list",
    sdkMethod: "listOrders",
    scope: "orders:read",
    summary: "List commerce orders (born from flow checkout)",
    usage: "orders list",
    positionals: [],
    flags: [],
    run: async (client) => client.listOrders(),
  },
  {
    cli: "orders get",
    sdkMethod: "getOrder",
    scope: "orders:read",
    summary: "Show one order with item snapshots",
    usage: "orders get <id>",
    positionals: ["id"],
    flags: [],
    run: async (client, args) => client.getOrder(args.positionals.id),
  },
  {
    cli: "appointments list",
    sdkMethod: "listAppointments",
    scope: "appointments:read",
    summary: "List appointment bookings",
    usage:
      "appointments list [--from <iso>] [--to <iso>] [--status <confirmed|cancelled>]",
    positionals: [],
    flags: [
      {
        name: "from",
        type: "string",
        description: "Only bookings starting at/after this ISO timestamp",
        valueName: "<iso>",
      },
      {
        name: "to",
        type: "string",
        description: "Only bookings starting at/before this ISO timestamp",
        valueName: "<iso>",
      },
      {
        name: "status",
        type: "string",
        description: "confirmed | cancelled",
        valueName: "<status>",
      },
    ],
    run: async (client, args) => {
      const status = args.getString("status");
      if (
        status !== undefined &&
        !["confirmed", "cancelled"].includes(status)
      ) {
        throw new UsageError(
          "--status must be one of: confirmed, cancelled",
        );
      }
      const query: ListAppointmentsQuery = {
        from: args.getString("from"),
        to: args.getString("to"),
        status: status as ListAppointmentsQuery["status"],
      };
      return client.listAppointments(query);
    },
  },
  {
    cli: "appointments services",
    sdkMethod: "listAppointmentServices",
    scope: "appointments:read",
    summary: "List appointment services (including inactive)",
    usage: "appointments services",
    positionals: [],
    flags: [],
    run: async (client) => client.listAppointmentServices(),
  },
];
