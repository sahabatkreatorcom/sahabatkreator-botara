/**
 * Regresi performa `requireAuth` (2026-11-05).
 *
 * Latar belakang: 26 modul mendaftarkan middleware ini pada pola path yang
 * SAMA (`app.use("/tenants/*", auth)`) di sub-app `routes` bersama. Hono
 * menjalankan semua handler yang cocok, jadi satu request dashboard
 * mengeksekusi `getSession` + `select users` 26 kali — terukur 217 ms untuk
 * `GET /api/tenants` padahal query-nya sendiri hanya 1–11 ms.
 *
 * Test ini mengunci dua hal sekaligus:
 * 1. Hono memang menjalankan semua pendaftaran ganda (asumsi yang membuat
 *    penjaga idempoten wajib ada) — kalau perilaku library berubah, test
 *    ini memberi tahu kita.
 * 2. `requireAuth` hanya menyentuh sesi + database SATU kali per request.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { User } from "@sahabat-kreator/db";
import type { AppVariables } from "../../http";
import type { AuthBundle } from "../../auth";
import { requireAuth } from "./session";

const APP_USER = {
  id: "user-1",
  authUserId: "auth-1",
  email: "probe@example.com",
  name: "Probe",
} as unknown as User;

interface Counter {
  sessions: number;
  selects: number;
  handler: number;
}

/**
 * Bundle palsu: hanya bagian yang benar-benar dipakai `requireAuth`.
 * Rantai Drizzle ditiru sampai `.limit()` karena itulah bentuk pemanggilan
 * di kode asli.
 */
function fakeBundle(counter: Counter): AuthBundle {
  return {
    auth: {
      api: {
        getSession: async () => {
          counter.sessions += 1;
          return { user: { id: "auth-1", email: "probe@example.com", name: "Probe" } };
        },
      },
    },
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              counter.selects += 1;
              return [APP_USER];
            },
          }),
        }),
      }),
    },
    pool: null,
  } as unknown as AuthBundle;
}

function buildApp(registrations: number, counter: Counter) {
  const app = new Hono<{ Variables: AppVariables }>();
  const auth = requireAuth(fakeBundle(counter));
  for (let i = 0; i < registrations; i++) {
    app.use("/tenants/*", auth);
  }
  app.get("/tenants", (c) => {
    counter.handler += 1;
    return c.json({ appUserId: c.get("appUser").id });
  });
  return app;
}

function emptyCounter(): Counter {
  return { sessions: 0, selects: 0, handler: 0 };
}

describe("requireAuth", () => {
  it("Hono menjalankan setiap pendaftaran ganda (alasan penjaga ini ada)", async () => {
    let invocations = 0;
    const app = new Hono<{ Variables: AppVariables }>();
    for (let i = 0; i < 26; i++) {
      app.use("/tenants/*", async (_c, next) => {
        invocations += 1;
        await next();
      });
    }
    app.get("/tenants", (c) => c.text("ok"));

    await app.request("/tenants");

    // Kalau angka ini berubah menjadi 1, Hono sudah berhenti menjalankan
    // middleware ganda dan penjaga di requireAuth boleh ditinjau ulang.
    expect(invocations).toBe(26);
  });

  it("hanya resolve sesi + baris users satu kali meski didaftarkan 26 kali", async () => {
    const counter = emptyCounter();
    const app = buildApp(26, counter);

    const res = await app.request("/tenants", {
      headers: { cookie: "session=whatever" },
    });

    expect(res.status).toBe(200);
    expect(counter.sessions).toBe(1);
    expect(counter.selects).toBe(1);
    expect(counter.handler).toBe(1);
    await expect(res.json()).resolves.toEqual({ appUserId: "user-1" });
  });

  it("hasilnya sama dengan pendaftaran tunggal (tidak ada perilaku yang berubah)", async () => {
    const single = emptyCounter();
    const singleRes = await buildApp(1, single).request("/tenants");

    const many = emptyCounter();
    const manyRes = await buildApp(26, many).request("/tenants");

    expect(manyRes.status).toBe(singleRes.status);
    await expect(manyRes.json()).resolves.toEqual(await singleRes.json());
  });
});
