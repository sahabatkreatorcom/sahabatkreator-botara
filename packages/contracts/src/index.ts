/**
 * Kontrak API Sahabat Kreator — sumber kebenaran tunggal (RANCANGAN §2 aturan 2).
 *
 * API memvalidasi dengan schema ini, SDK MENGONSUMSI tipenya (transport-nya
 * ditulis tangan — tidak ada codegen), dan schema tool MCP diturunkan
 * darinya. Error API membawa KODE, bukan kalimat (RANCANGAN §11.1).
 *
 * File ini hanya BARREL: definisi hidup di modul per domain di folder ini
 * (Fase 13D — sebelumnya satu berkas >4.000 baris). Tambahkan schema baru ke
 * modul domain yang sesuai, lalu ekspor lewat `export *` di bawah.
 */
export * from "./common";
export * from "./tenants";
export * from "./contacts";
export * from "./inbox";
export * from "./channels";
export * from "./meta-oauth";
export * from "./webchat";
export * from "./automations";
export * from "./automation-templates";
export * from "./comments";
export * from "./agents";
export * from "./commerce";
export * from "./api-keys";
export * from "./realtime";
export * from "./admin";
export * from "./admin-console";
export * from "./integration-logs";
export * from "./audit";
export * from "./analytics";
export * from "./dashboard";
export * from "./broadcasts";
export * from "./whatsapp-templates";
export * from "./flows";
export * from "./experiments";
export * from "./flow-templates";
export * from "./saved-replies";
export * from "./growth";
export * from "./segments";
export * from "./orders";
export * from "./appointments";
export * from "./public-v1";
